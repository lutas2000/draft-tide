// Stand-in clients for the peer-identity checks. The same source is built
// and signed several times (see src/build.ts):
//   desktop-sim  identifier dev.drafttide.spike.desktop   (the "real app")
//   forged       same identifier, different code (built with -DVARIANT)
//   attacker     identifier dev.drafttide.spike.attacker
//
// Plain check (server judges the peer when it reads the request):
//   client connect   <socket> <label>             send one request, print the reply
//   client fork-race <socket> <label> <genuine>   connect, fork: the child sends while
//                                                 the parent execs <genuine>
//   client send-exec <socket> <label> <genuine>   send the request, then exec <genuine>
//                                                 before the server checks it
// Handshake (server pins the peer's audit token, then asks for a nonce echo):
//   client hs           <socket> <label>            the honest handshake
//   client hs-send-exec <socket> <label> <genuine>  send hello, then exec <genuine>
//   client hs-fork      <socket> <label> <genuine>  send hello, fork: the parent execs
//                                                   <genuine>; the child waits until the
//                                                   server has pinned T0, then echoes
//   client hs-fork-eager <socket> <label> <genuine> same, but the child starts reading at
//                                                   once (blocked in read() on the socket)
//   client sleep                                    idle for 3 s (what <genuine> runs as)
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef VARIANT
#define VARIANT "genuine"
#endif

static int dial(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_un a;
  memset(&a, 0, sizeof a);
  a.sun_family = AF_UNIX;
  strncpy(a.sun_path, path, sizeof a.sun_path - 1);
  if (connect(fd, (struct sockaddr *)&a, sizeof a) != 0) return -1;
  return fd;
}

static int send_hello(int fd, const char *label, int delay_ms, int handshake) {
  char line[512];
  int n = snprintf(line, sizeof line, "{\"label\":\"%s\",\"pid\":%d,\"variant\":\"%s\",\"delayMs\":%d,\"handshake\":%s}\n", label, getpid(), VARIANT, delay_ms, handshake ? "true" : "false");
  return write(fd, line, (size_t)n) == n ? 0 : 1;
}

// Reads one '\n'-terminated line (byte at a time: the spike's lines are short).
static int read_line(int fd, char *buf, size_t cap) {
  size_t n = 0;
  while (n + 1 < cap) {
    ssize_t got = read(fd, buf + n, 1);
    if (got <= 0) break;
    if (buf[n++] == '\n') break;
  }
  buf[n] = 0;
  return (int)n;
}

static int print_reply(int fd) {
  char buf[8192];
  read_line(fd, buf, sizeof buf);
  fputs(buf, stdout);
  return 0;
}

// Answers the server's nonce: {"nonce":"<n>"} -> {"echo":"<n>","pid":<pid>}
static int echo_nonce(int fd) {
  char buf[512];
  if (read_line(fd, buf, sizeof buf) <= 0) return 1;
  const char *k = strstr(buf, "\"nonce\":\"");
  if (!k) return 1;
  k += 9;
  const char *end = strchr(k, '"');
  if (!end) return 1;
  char line[512];
  int n = snprintf(line, sizeof line, "{\"echo\":\"%.*s\",\"pid\":%d}\n", (int)(end - k), k, getpid());
  return write(fd, line, (size_t)n) == n ? 0 : 1;
}

static void become(const char *genuine) {
  execl(genuine, genuine, "sleep", (char *)NULL);
  perror("exec");
  _exit(4);
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "sleep") == 0) {
    sleep(3);
    return 0;
  }
  if (argc < 4) {
    fprintf(stderr, "usage: client <mode> <socket> <label> [genuine]\n");
    return 64;
  }
  const char *mode = argv[1];
  const char *genuine = argc >= 5 ? argv[4] : NULL;
  int fd = dial(argv[2]);
  if (fd < 0) { perror("connect"); return 2; }

  if (strcmp(mode, "connect") == 0) {
    if (send_hello(fd, argv[3], 0, 0)) return 1;
    return print_reply(fd);
  }
  if (strcmp(mode, "hs") == 0) {
    if (send_hello(fd, argv[3], 0, 1) || echo_nonce(fd)) return 1;
    return print_reply(fd);
  }
  if (!genuine) return 64;
  if (strcmp(mode, "fork-race") == 0) {
    pid_t child = fork();
    if (child < 0) return 3;
    if (child == 0) {
      usleep(400 * 1000); // let the parent exec first
      if (send_hello(fd, argv[3], 0, 0)) return 1;
      return print_reply(fd);
    }
    become(genuine); // the connection was made by this pid
  }
  if (strcmp(mode, "send-exec") == 0) {
    // The server is asked to pause before checking, which makes the race
    // deterministic; a real attacker only needs the exec to win once.
    if (send_hello(fd, argv[3], 300, 0)) return 1;
    become(genuine);
  }
  if (strcmp(mode, "hs-send-exec") == 0) {
    if (send_hello(fd, argv[3], 300, 1)) return 1;
    become(genuine);
  }
  if (strcmp(mode, "hs-fork") == 0 || strcmp(mode, "hs-fork-eager") == 0) {
    int eager = strcmp(mode, "hs-fork-eager") == 0;
    if (send_hello(fd, argv[3], 300, 1)) return 1;
    pid_t child = fork();
    if (child < 0) return 3;
    if (child == 0) {
      // Touching the socket makes this process the reported peer, so the
      // patient attacker stays off it until the server has pinned T0.
      if (!eager) usleep(600 * 1000);
      if (echo_nonce(fd)) return 1;
      return print_reply(fd);
    }
    become(genuine);
  }
  fprintf(stderr, "unknown mode %s\n", mode);
  return 64;
}
