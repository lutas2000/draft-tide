// Probe: a library injected with DYLD_INSERT_LIBRARIES writes a marker file
// (path from DT_INJECT_MARK) when dyld loads it into a process.
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>

__attribute__((constructor)) static void injected(void) {
  const char *mark = getenv("DT_INJECT_MARK");
  if (!mark) return;
  int fd = open(mark, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd >= 0) {
    write(fd, "injected\n", 9);
    close(fd);
  }
}
