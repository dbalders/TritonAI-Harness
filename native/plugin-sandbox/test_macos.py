"""Run with an explicit Node executable: python3 test_macos.py --node /absolute/node."""

import argparse
from contextlib import closing
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

parser = argparse.ArgumentParser()
parser.add_argument("--node", required=True, type=Path)
options, test_arguments = parser.parse_known_args()


@unittest.skipUnless(sys.platform == "darwin", "macOS native confinement tests")
class MacSandboxTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = options.node.resolve(strict=True)
        cls.directory = tempfile.TemporaryDirectory(prefix="plugin-sandbox-")
        cls.root = Path(cls.directory.name).resolve()
        cls.helper = cls.root / "supervisor"
        subprocess.run(
            ["xcrun", "clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
             str(Path(__file__).with_name("macos.c")), "-lsandbox", "-o", str(cls.helper)],
            check=True, capture_output=True, timeout=30,
        )

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def command(self, source, cpu=2, wall=3000):
        entry = self.root / f"{self._testMethodName}.cjs"
        entry.write_text(source)
        quote = lambda path: json.dumps(str(path), ensure_ascii=False)
        policy = self.root / f"{self._testMethodName}.sb"
        policy.write_text(f"""(version 1)
(deny default)
(import "dyld-support.sb")
(allow syscall*)
(allow mach-bootstrap)
(allow signal (target self))
(allow sysctl-read)
(allow process-exec (literal {quote(self.node)}))
(allow file-read* (subpath "/System/Library") (subpath "/usr/lib")
  (literal {quote(self.node)}) (literal {quote(entry)}))
(allow file-map-executable (subpath "/System/Library") (subpath "/usr/lib")
  (literal {quote(self.node)}))
(allow file-read-metadata file-test-existence
  (path-ancestors {quote(entry)}) (path-ancestors {quote(self.node)}))
""")
        return [str(self.helper), str(self.node), str(entry), str(policy),
                str(self.root), str(cpu), str(wall)]

    def start(self, source, cpu=2, wall=3000, pass_fds=()):
        return subprocess.Popen(
            self.command(source, cpu, wall), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
            pass_fds=pass_fds, env={"SYNTHETIC_PARENT_SECRET": "synthetic-only"},
        )

    def result(self, source, cpu=2, wall=3000, pass_fds=()):
        process = self.start(source, cpu, wall, pass_fds)
        control = process.stdin
        process.stdin = None  # Keep the host pipe open until the worker has completed.
        try:
            output, error = process.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise
        finally:
            control.close()
        return process.returncode, output.decode(), error.decode()

    def ready(self, process):
        self.assertTrue(select.select([process.stdout], [], [], 5)[0], "worker never became ready")
        return json.loads(process.stdout.readline())["pid"]

    def assert_absent(self, *pids):
        status = subprocess.run(
            ["/bin/ps", "-o", "pid=,state=", "-p", ",".join(map(str, pids))],
            capture_output=True, text=True, timeout=2,
        )
        self.assertEqual(status.stdout.strip(), "")

    def test_denied_capabilities(self):
        outside = self.root / "synthetic-secret.txt"
        outside.write_text("synthetic-only")
        link = self.root / "escape-link"
        link.symlink_to(outside)
        descriptor = os.open(outside, os.O_RDONLY)
        high = fcntl.fcntl(descriptor, fcntl.F_DUPFD, 200)
        os.close(descriptor)
        receiver = socket.socket()
        receiver.bind(("127.0.0.1", 0))
        receiver.listen()
        receiver.settimeout(0.1)
        arrivals = []
        done = threading.Event()

        def receive():
            while not done.is_set():
                try:
                    connection, _ = receiver.accept()
                    arrivals.append(True)
                    connection.close()
                except socket.timeout:
                    continue
                except OSError:
                    return

        thread = threading.Thread(target=receive)
        thread.start()
        source = """const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
const result={};
function denied(name,action){try{action();result[name]=false}catch(e){result[name]=e.code==='EPERM'}}
result.ownCodeReadable=fs.readFileSync(__filename,'utf8').includes('ownCodeReadable');
result.parentSecretAbsent=!Object.hasOwn(process.env,'SYNTHETIC_PARENT_SECRET');
denied('outsideRead',()=>fs.readFileSync(OUTSIDE));
denied('symlinkRead',()=>fs.readFileSync(LINK));
denied('outsideWrite',()=>fs.writeFileSync(OUTSIDE+'.write','synthetic'));
denied('codeWrite',()=>fs.appendFileSync(__filename,' '));
denied('codeChmod',()=>fs.chmodSync(__filename,0o777));
try{fs.fstatSync(HIGH);result.inheritedFdAbsent=false}catch(e){result.inheritedFdAbsent=e.code==='EBADF'}
denied('signalParent',()=>process.kill(process.ppid,'SIGTERM'));
const child=cp.spawnSync(process.execPath,['-e','process.stdout.write("child")'],{timeout:500});
result.spawnDenied=child.error?.code==='EPERM';
Promise.all([
 new Promise(resolve=>{const s=net.createConnection({host:'127.0.0.1',port:PORT});
  s.once('connect',()=>{s.destroy();resolve(false)});s.once('error',e=>resolve(e.code==='EPERM'));
  s.setTimeout(1000,()=>{s.destroy();resolve(false)})}),
 new Promise(resolve=>{const s=net.createServer();s.once('error',e=>resolve(e.code==='EPERM'));
  s.listen(0,'127.0.0.1',()=>s.close(()=>resolve(false)))})
]).then(([tcp,listen])=>{result.tcpDenied=tcp;result.listenDenied=listen;console.log(JSON.stringify(result))});
"""
        source = (source.replace("OUTSIDE", json.dumps(str(outside)))
                  .replace("LINK", json.dumps(str(link))).replace("HIGH", str(high))
                  .replace("PORT", str(receiver.getsockname()[1])))
        try:
            code, output, error = self.result(source, pass_fds=(high,))
            self.assertEqual((code, error), (0, ""))
            observations = json.loads(output)
            self.assertEqual(len(observations), 12)
            self.assertTrue(all(observations.values()), observations)
            self.assertEqual(arrivals, [])
        finally:
            os.close(high)
            done.set()
            receiver.close()
            thread.join()

    def test_cpu_signal_cannot_disable_supervisor_budget(self):
        started = time.monotonic()
        code, output, _ = self.result(
            'process.on("SIGXCPU",()=>{});console.log(JSON.stringify({pid:process.pid}));for(;;){}',
            cpu=1, wall=5000,
        )
        self.assertEqual(code, 126)
        self.assertLess(time.monotonic() - started, 5)
        self.assert_absent(json.loads(output)["pid"])

    def test_wall_timeout_reaps_worker(self):
        code, output, _ = self.result(
            'console.log(JSON.stringify({pid:process.pid}));setInterval(()=>{},10000)', wall=500,
        )
        self.assertEqual(code, 124)
        self.assert_absent(json.loads(output)["pid"])

    def test_host_pipe_loss_reaps_worker(self):
        process = self.start('console.log(JSON.stringify({pid:process.pid}));setInterval(()=>{},10000)')
        worker = self.ready(process)
        process.stdin.close()
        self.assertEqual(process.wait(timeout=3), 125)
        self.assert_absent(worker)
        process.stdout.close()
        process.stderr.close()

    def test_parent_exit_reaps_worker_while_host_pipe_remains_open(self):
        command = self.command('console.log(JSON.stringify({pid:process.pid}));setInterval(()=>{},10000)')
        wrapper = """import subprocess,sys,json,os
p=subprocess.Popen(json.loads(sys.argv[1]),stdin=sys.stdin.buffer,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
worker=json.loads(p.stdout.readline())['pid']
print(json.dumps({'helper':p.pid,'worker':worker}),flush=True)
os._exit(0)
"""
        process = subprocess.Popen(
            [sys.executable, "-c", wrapper, json.dumps(command)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        control = process.stdin
        process.stdin = None
        try:
            output, _ = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0)
            pids = list(json.loads(output).values())
            with closing(select.kqueue()) as queue:
                watching = 0
                for pid in pids:
                    try:
                        queue.control([select.kevent(
                            pid, filter=select.KQ_FILTER_PROC,
                            flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                            fflags=select.KQ_NOTE_EXIT,
                        )], 0, 0)
                        watching += 1
                    except ProcessLookupError:
                        pass
                if watching:
                    queue.control(None, watching, 2)
            self.assert_absent(*pids)
        finally:
            control.close()


unittest.main(argv=[sys.argv[0], *test_arguments])
