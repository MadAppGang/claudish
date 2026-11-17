// Reads the launch logs of one trial.

/** The sandbox cwd a launch log records, or undefined. */
export function launchCwd(launchText: string): string | undefined {
  return launchText.match(/^launch: cwd (.*)$/m)?.[1];
}

/**
 * Whether two launch logs record the same cwd. On macOS /var, /tmp and /etc
 * are symlinks into /private, and two launches of one trial can write either
 * spelling of the same sandbox folder. The sandbox is gone when the readout
 * runs, so the paths are compared as text, not resolved on disk.
 */
export function sameLaunchCwd(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

function canonical(path: string): string {
  return path.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, "");
}
