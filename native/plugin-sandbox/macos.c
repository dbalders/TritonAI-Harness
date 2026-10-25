#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <sandbox.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum { PROFILE_MAX = 32768, WALL_MAX_MS = 30000, CPU_MAX_SECONDS = 10 };
static volatile sig_atomic_t stopping;

static void stop_requested(int signal_number) { stopping = signal_number; }

static int fail(const char *message) {
  fprintf(stderr, "plugin sandbox: %s\n", message);
  return 125;
}

static bool bounded_number(const char *value, unsigned maximum, unsigned *result) {
  char *end = NULL;
  errno = 0;
  unsigned long number = strtoul(value, &end, 10);
  if (errno || !*value || *end || number == 0 || number > maximum) return false;
  *result = (unsigned)number;
  return true;
}

static int64_t monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static bool limit(int resource, rlim_t maximum) {
  struct rlimit value = {maximum, maximum};
  return setrlimit(resource, &value) == 0;
}

static void child_failed(unsigned char category) {
  (void)write(3, &category, sizeof(category));
  _exit(127);
}

static int exit_status(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 125;
}

static int reap(pid_t child, bool terminate) {
  if (terminate) (void)kill(child, SIGKILL);
  int status;
  pid_t result;
  do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
  return result == child ? exit_status(status) : 125;
}

int main(int argc, char **argv) {
  if (argc != 7) return fail("expected runtime, entry, policy, cwd, CPU seconds and wall milliseconds");
  unsigned cpu, wall;
  if (!bounded_number(argv[5], CPU_MAX_SECONDS, &cpu) ||
      !bounded_number(argv[6], WALL_MAX_MS, &wall)) return fail("invalid resource budget");
  for (int index = 1; index <= 4; index++) {
    if (argv[index][0] != '/' || strnlen(argv[index], PATH_MAX) == PATH_MAX)
      return fail("paths must be bounded and absolute");
  }
  int profile_fd = open(argv[3], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat profile_stat;
  if (profile_fd < 0 || fstat(profile_fd, &profile_stat) != 0 ||
      !S_ISREG(profile_stat.st_mode) || profile_stat.st_size <= 0 ||
      profile_stat.st_size > PROFILE_MAX) return fail("invalid policy file");
  char profile[PROFILE_MAX + 1];
  size_t count = 0;
  while (count < (size_t)profile_stat.st_size) {
    ssize_t bytes = read(profile_fd, profile + count, (size_t)profile_stat.st_size - count);
    if (bytes < 0 && errno == EINTR) continue;
    if (bytes <= 0) return fail("could not read policy");
    count += (size_t)bytes;
  }
  close(profile_fd);
  if (memchr(profile, '\0', count)) return fail("invalid policy encoding");
  profile[count] = '\0';

  pid_t parent = getppid();
  if (parent <= 1) return fail("parent is unavailable");
  struct sigaction action = {0};
  action.sa_handler = stop_requested;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL) ||
      sigaction(SIGHUP, &action, NULL)) return fail("could not install lifecycle handlers");
  signal(SIGPIPE, SIG_IGN);

  int queue = kqueue();
  int setup[2];
  if (queue < 0 || pipe(setup) != 0) return fail("could not create supervisor handles");
  if (fcntl(setup[0], F_SETFL, O_NONBLOCK) < 0 ||
      fcntl(setup[1], F_SETFD, FD_CLOEXEC) < 0) return fail("could not constrain setup pipe");
  struct kevent parent_event;
  EV_SET(&parent_event, (uintptr_t)parent, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_CLEAR, NOTE_EXIT, 0, NULL);
  if (kevent(queue, &parent_event, 1, NULL, 0, NULL) < 0 || getppid() != parent)
    return fail("could not observe parent lifetime");
  int64_t started = monotonic_ms();
  if (started < 0) return fail("monotonic clock is unavailable");
  mach_timebase_info_data_t timebase;
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.numer || !timebase.denom)
    return fail("CPU accounting timebase is unavailable");
  // This dedicated supervisor has no threads: enumerate after opening every supervisor handle.
  int inherited_fds[1024];
  size_t inherited_count = 0;
  DIR *descriptors = opendir("/dev/fd");
  if (!descriptors) return fail("could not inventory inherited descriptors");
  struct dirent *entry;
  while ((entry = readdir(descriptors)) != NULL) {
    char *end;
    long descriptor = strtol(entry->d_name, &end, 10);
    if (!*entry->d_name || *end || descriptor < 4 || descriptor > INT_MAX) continue;
    if (inherited_count == sizeof(inherited_fds) / sizeof(inherited_fds[0]))
      return fail("inherited descriptor inventory exceeds budget");
    inherited_fds[inherited_count++] = (int)descriptor;
  }
  closedir(descriptors);
  pid_t child = fork();
  if (child < 0) return fail("could not create worker");
  if (child == 0) {
    if (setup[1] != 3 && dup2(setup[1], 3) < 0) _exit(127);
    if (fcntl(3, F_SETFD, FD_CLOEXEC) < 0) _exit(127);
    for (size_t index = 0; index < inherited_count; index++) close(inherited_fds[index]);
    signal(SIGPIPE, SIG_DFL);
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    if (!limit(RLIMIT_CPU, cpu) || !limit(RLIMIT_CORE, 0) ||
        !limit(RLIMIT_FSIZE, 0) || !limit(RLIMIT_NOFILE, 32) || chdir(argv[4]) != 0)
      child_failed(1);
    char *sandbox_error = NULL;
    // Seatbelt is deprecated. Admission must pin and verify this helper/policy on each supported OS.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    int sandbox_result = sandbox_init(profile, 0, &sandbox_error);
#pragma clang diagnostic pop
    if (sandbox_result != 0) child_failed(2);
    char *const arguments[] = {argv[1], "--no-addons", "--disable-proto=throw",
                              "--max-old-space-size=48", argv[2], NULL};
    char *const environment[] = {"LANG=C", "TZ=UTC", "UV_THREADPOOL_SIZE=1", NULL};
    execve(argv[1], arguments, environment);
    child_failed(3);
  }
  close(setup[1]);
  struct kevent changes[3];
  EV_SET(&changes[0], (uintptr_t)child, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_CLEAR, NOTE_EXIT, 0, NULL);
  EV_SET(&changes[1], STDIN_FILENO, EVFILT_READ, EV_ADD | EV_ENABLE | EV_CLEAR, 0, 0, NULL);
  EV_SET(&changes[2], (uintptr_t)setup[0], EVFILT_READ, EV_ADD | EV_ENABLE | EV_CLEAR, 0, 0, NULL);
  if (kevent(queue, changes, 3, NULL, 0, NULL) < 0) {
    reap(child, true);
    return fail("could not observe worker lifetime");
  }
  for (;;) {
    int64_t now = monotonic_ms();
    if (stopping || now < 0 || now - started >= wall) {
      reap(child, true);
      return stopping ? 128 + stopping : 124;
    }
    struct rusage_info_v2 usage;
    if (proc_pid_rusage(child, RUSAGE_INFO_V2, (rusage_info_t *)&usage) != 0) {
      int status;
      if (waitpid(child, &status, WNOHANG) == child) return exit_status(status);
      reap(child, true);
      return fail("CPU accounting is unavailable");
    }
    // proc_pid_rusage reports Mach ticks, including on arm64 where one tick is not one nanosecond.
    __uint128_t cpu_ticks = (__uint128_t)usage.ri_user_time + usage.ri_system_time;
    if (cpu_ticks * timebase.numer >= (__uint128_t)cpu * 1000000000 * timebase.denom) {
      reap(child, true);
      return 126;
    }
    int64_t remaining = (int64_t)wall - (now - started);
    // A worker can catch SIGXCPU; enforce CPU use outside its signal handlers as well.
    if (remaining > 20) remaining = 20;
    struct timespec timeout = {remaining / 1000, (remaining % 1000) * 1000000};
    struct kevent events[4];
    int size = kevent(queue, NULL, 0, events, 4, &timeout);
    if (size < 0 && errno == EINTR) continue;
    if (size < 0) {
      reap(child, true);
      return fail("supervisor observation failed");
    }
    // Parent loss wins over worker output; only the host can settle an admitted external commit.
    for (int index = 0; index < size; index++) {
      struct kevent event = events[index];
      if ((event.flags & EV_ERROR) ||
          (event.filter == EVFILT_PROC && event.ident == (uintptr_t)parent) ||
          (event.filter == EVFILT_READ && event.ident == STDIN_FILENO && (event.flags & EV_EOF))) {
        reap(child, true);
        return 125;
      }
    }
    for (int index = 0; index < size; index++) {
      struct kevent event = events[index];
      if (event.filter == EVFILT_READ && event.ident == (uintptr_t)setup[0]) {
        unsigned char category;
        if (read(setup[0], &category, sizeof(category)) > 0) {
          reap(child, true);
          return fail("worker confinement or exec failed");
        }
      }
      if (event.filter == EVFILT_PROC && event.ident == (uintptr_t)child) return reap(child, false);
    }
  }
}
