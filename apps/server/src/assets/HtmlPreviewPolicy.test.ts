// @effect-diagnostics nodeBuiltinImport:off - isolated TCP/UDP receivers observe real browser egress.
import { describe, expect, it } from "vite-plus/test";
import { parse, serialize } from "parse5";
import { offlineHtmlPreview } from "./HtmlPreviewPolicy.ts";

describe("offline HTML preview", () => {
  it("preserves offline controls and raster data while removing executable and navigation routes", () => {
    const result = offlineHtmlPreview(`
      <style>p { color: red }</style><details open><summary>Details</summary><p>Offline</p></details>
      <form action="https://example.invalid/submit"><input value="canary"><button>Save</button></form>
      <img src="data:image/png;base64,aGVsbG8=">
      <a href="#details">Jump</a><a href="https://example.invalid/leak">External</a>
      <script>fetch('https://example.invalid/script')</script>
      <img src="https://example.invalid/image" onerror="fetch('/leak')">
      <iframe srcdoc="<script>escape()</script>"></iframe>
      <meta http-equiv="refresh" content="0;url=https://example.invalid/meta">
      <link rel="dns-prefetch" href="//example.invalid"><base href="https://example.invalid/">
      <svg><a href="https://example.invalid/svg">Link</a></svg>
    `);
    expect(result.html).toContain('<details open=""><summary>Details</summary>');
    expect(result.html).toContain('<input value="canary">');
    expect(result.html).toContain('src="data:image/png;base64,aGVsbG8="');
    expect(result.html).toContain('href="#details"');
    expect(result.html).not.toContain("example.invalid");
    expect(result.html).not.toContain("onerror");
    expect(result.html).not.toContain("<iframe");
    expect(result.html.match(/<script/g)).toHaveLength(1);
    expect(result.headers["Content-Security-Policy"]).toContain("form-action 'none'");
    expect(result.headers["Content-Security-Policy"]).toContain("connect-src 'none'");
    expect(result.headers["Content-Security-Policy"]).not.toContain(
      "'unsafe-inline' 'unsafe-eval'",
    );
    expect(result.headers["Referrer-Policy"]).toBe("no-referrer");
  });

  it("keeps CSS egress denied and nonces independent of attacker-provided attributes", () => {
    const first = offlineHtmlPreview(
      '<style>@import "https://example.invalid/style";</style><script nonce="chosen">attack()</script>',
    );
    const second = offlineHtmlPreview("<p>Same document</p>");
    expect(first.html).not.toContain("attack()");
    expect(first.html).not.toContain('nonce="chosen"');
    expect(first.headers["Content-Security-Policy"]).not.toBe(
      second.headers["Content-Security-Policy"],
    );
    expect(first.headers["Content-Security-Policy"]).toContain("style-src 'unsafe-inline'");
    expect(first.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(first.headers["Cache-Control"]).toBe("private, no-store");
  });

  it("does not revive scripts after browser reparsing of malformed and foreign markup", () => {
    const result = offlineHtmlPreview(
      '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=attack()>"><template><script>nested()</script></template>',
    );
    const reparsed = serialize(parse(result.html));
    expect(reparsed).not.toContain("attack()");
    expect(reparsed).not.toContain("nested()");
    expect(reparsed.match(/<script/g)).toHaveLength(1);
  });
});

it("keeps a real browser offline while details and inputs still work", async (ctx) => {
  const executablePath = process.env.T3CODE_TEST_HEADLESS_SHELL;
  if (!executablePath)
    return ctx.skip("Set T3CODE_TEST_HEADLESS_SHELL for real browser acceptance.");
  const NodeHttp = await import("node:http");
  const NodeDgram = await import("node:dgram");
  const { chromium } = await import("playwright-core");
  const requests: Array<string> = [];
  const datagrams: Array<string> = [];
  const udp = NodeDgram.createSocket("udp4");
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  udp.on("message", (bytes) => datagrams.push(bytes.toString("hex")));
  const receiver = NodeHttp.createServer((req, res) => {
    requests.push(req.url ?? "");
    res.end("canary");
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address();
  if (address === null || typeof address === "string") throw new Error("Missing canary port");
  const canary = `http://127.0.0.1:${address.port}`;
  const preview = offlineHtmlPreview(`
    <details><summary>Report details</summary><p>Offline content</p></details>
    <label>Notes <input id="notes"></label><a href="${canary}/link">External link</a>
    <form action="${canary}/form"><button>Submit</button></form>
    <style>@import "${canary}/import";body{background-image:url(${canary}/css)}</style>
    <img src="${canary}/image"><video src="${canary}/video" autoplay></video>
    <iframe src="${canary}/frame"></iframe><link rel="dns-prefetch" href="//localhost">
    <meta http-equiv="refresh" content="0;url=${canary}/refresh">
    <script>fetch('${canary}/fetch');new XMLHttpRequest().open('GET','${canary}/xhr');
    new WebSocket('ws://127.0.0.1:${address.port}/ws');window.open('${canary}/popup');
    const p=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'}]});
    p.createDataChannel('x');p.createOffer().then(o=>p.setLocalDescription(o));
    location.href='${canary}/navigate';</script>
  `);
  const documentServer = NodeHttp.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html", ...preview.headers });
    res.end(preview.html);
  });
  await new Promise<void>((resolve) => documentServer.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const documentAddress = documentServer.address();
    if (documentAddress === null || typeof documentAddress === "string")
      throw new Error("Missing document port");
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${documentAddress.port}/`);
    await page.getByText("Report details", { exact: true }).click();
    await page.getByText("Offline content", { exact: true }).waitFor({ state: "visible" });
    await page.getByLabel("Notes").fill("Local notes");
    expect(await page.getByLabel("Notes").inputValue()).toBe("Local notes");
    await page.getByText("External link", { exact: true }).click();
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    expect(await page.locator("details[open]").count()).toBe(1);
    expect(requests).toEqual([]);
    expect(datagrams).toEqual([]);
  } finally {
    await browser.close();
    await Promise.all([
      new Promise<void>((resolve) => documentServer.close(() => resolve())),
      new Promise<void>((resolve) => receiver.close(() => resolve())),
      new Promise<void>((resolve) => udp.close(resolve)),
    ]);
  }
}, 30_000);
