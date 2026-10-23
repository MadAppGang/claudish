import { constants } from "node:os";

/**
 * `128 + signum`, the shell's code for a process that died from `signal`. The number
 * comes from the OS, never from a literal table, which would have to list every signal:
 * numbers differ by platform (SIGBUS is 10 on darwin, 7 on Linux), and a signal left out,
 * such as the OOM killer's SIGKILL, would read 128. A signal this platform does not know
 * still gives 128, never the 0 of success.
 */
export function signalExitCode(signal: NodeJS.Signals): number {
  const signum = (constants.signals as unknown as Record<string, number | undefined>)[signal];
  return typeof signum === "number" ? 128 + signum : 128;
}
