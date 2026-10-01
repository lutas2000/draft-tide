// Probe: can this process get another same-user process's task port (the
// handle a debugger or memory reader needs)?
//   taskport <pid>   prints {"pid":…,"kr":…,"error":"…"}; exit 0 if granted
#include <mach/mach.h>
#include <mach/mach_error.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  int pid = atoi(argv[1]);
  mach_port_t task = MACH_PORT_NULL;
  kern_return_t kr = task_for_pid(mach_task_self(), pid, &task);
  printf("{\"pid\":%d,\"kr\":%d,\"error\":\"%s\"}\n", pid, kr, mach_error_string(kr));
  return kr == KERN_SUCCESS ? 0 : 1;
}
