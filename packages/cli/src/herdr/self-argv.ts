/**
 * The argv that runs this same claudish, for a program another process starts on our behalf
 * (a herdr pane runs `<selfArgv> view <target>`). A herdr-created pane inherits the herdr server's
 * environment, not ours, so a bare `claudish` could be another install or none at all.
 */

import { resolveClaudishSpawn } from "../spawn-claudish.js";

const SCRIPT = /\.(ts|tsx|js|mjs|cjs)$/;

export interface SelfArgvInput {
  env?: Readonly<Record<string, string | undefined>>;
  execPath?: string;
  /** `process.argv` */
  argv?: readonly string[];
}

export function selfArgv(input: SelfArgvInput = {}): string[] {
  const env = input.env ?? process.env;
  const execPath = input.execPath ?? process.execPath;
  const argv = input.argv ?? process.argv;
  if (env.CLAUDISH_BIN?.trim()) {
    const spawn = resolveClaudishSpawn(env as NodeJS.ProcessEnv);
    return [spawn.command, ...spawn.prefixArgs];
  }
  const script = argv[1];
  if (script && SCRIPT.test(script)) return [execPath, "--no-env-file", "run", script];
  // a compiled claudish is its own executable
  return [execPath];
}
