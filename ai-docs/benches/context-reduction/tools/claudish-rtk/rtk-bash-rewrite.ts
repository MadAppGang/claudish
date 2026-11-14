/// <reference path="./claudish-hooks.d.ts" />
/**
 * Replaces a Bash command with the form `rtk rewrite` returns, so the command
 * prints shorter output. Needs `rtk` on the PATH of the claudish process.
 */
import { act, defineHook } from "claudish/hooks";

// claudish runs hooks under Bun. This declares the one Bun call the hook makes.
declare const Bun: {
  spawn(
    cmd: string[],
    opts: { signal: AbortSignal; stdout: "pipe"; stderr: "ignore" }
  ): { stdout: ReadableStream<Uint8Array>; exited: Promise<number> };
};

export default defineHook({
  apiVersion: 1,
  id: "rtk-bash-rewrite",
  description: "Replaces a Bash command with its rtk form",
  defaultSeverity: "fix",
  routes: "all",
  timeoutMs: 2000,
  on: {
    toolCall: {
      tools: ["Bash"],
      async handle(ctx) {
        const command = ctx.tool.args.command;
        if (typeof command !== "string" || command.trim() === "") return;
        // ctx.signal stops rtk when the hook's timeout runs out. `--` keeps a command
        // that starts with a dash, such as `--help`, from being read as an rtk flag.
        const proc = Bun.spawn(["rtk", "rewrite", "--", command], {
          signal: ctx.signal,
          stdout: "pipe",
          stderr: "ignore",
        });
        const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        // Exit 0 and 3 print a rewritten command. Exit 1 and 2 mean no rewrite.
        if (code === 1 || code === 2) return;
        // Any other code is a failure. Throwing lets the journal record it and the
        // five-failure limit count it. The message never holds the command.
        if (code !== 0 && code !== 3) throw new Error(`rtk rewrite exited with code ${code}`);
        const rewritten = stdout.trim();
        if (rewritten === "" || rewritten === command) return;
        // The reason goes to the journal. It never holds the command.
        return [act.repairToolArgs({ ...ctx.tool.args, command: rewritten }, "rtk rewrite")];
      },
    },
  },
});
