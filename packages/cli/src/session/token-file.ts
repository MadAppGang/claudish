/**
 * This session's token file: the path `TokenTracker.writeFile` writes to, the path the
 * status line reads, and the path the end-of-session summary reads. ONE resolver for
 * the writer and all its readers — kept in its own module so the proxy's tracker can
 * import it without the summary's pricing dependencies.
 *
 * An inherited `CLAUDISH_TOKEN_FILE` wins: a parent (team, the MCP channel, a pane)
 * names the file the child's proxy writes, and the tracker honours it. Otherwise it is
 * `<home>/.claudish/tokens-<port>.json`, `<home>` by the `$HOME`-first rule.
 *
 * `createTempSettingsFile` used to build the default path itself and ignore the
 * override, so a child with an inherited `CLAUDISH_TOKEN_FILE` drew its status line
 * from a port-keyed file nobody wrote; and the tracker built it with `os.homedir()`,
 * which Bun resolves from the passwd entry and never from a runtime `$HOME`, so with a
 * redirected HOME the summary read a file the tracker never wrote.
 */

import { join } from "node:path";
import { userHomeFrom } from "../channel/home-dir.js";

export function resolveTokenFilePath(
  port: number | string,
  env: Record<string, string | undefined> = process.env
): string {
  return env.CLAUDISH_TOKEN_FILE || join(userHomeFrom(env), ".claudish", `tokens-${port}.json`);
}
