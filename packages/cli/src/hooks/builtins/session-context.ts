/**
 * Built-in hook `session-context/no-harness-echo`: keep Claude Code's own
 * session context OUT of the model's answer.
 *
 * Background (measured, not assumed). A `SessionStart` hook's stdout is NOT
 * written to `claude -p`'s stdout — probed 2026-08-18 against CC 2.1.233 with a
 * hook emitting a sentinel and a one-word prompt: stdout came back as exactly
 * `"banana\n"`, sentinel absent from both stdout and stderr. So hook output
 * reaches the model the only other way it can: as injected context the model
 * READS.
 *
 * Which means a foreign model can decide it is content to reproduce. In team
 * session team-20260815-115227, `response-01.md` (minimax-m3) and
 * `response-04.md` (kimi-k3) both OPEN with the host session's SessionStart
 * output — a "Coaching" block recommending `npx claudeup`, and an "Insight"
 * block — instead of the requested deliverable. The blind judges penalised both
 * in those words: "leaked harness boilerplate in deliverable", "irrelevant
 * coaching preamble violates the requested structure". Two of six models, and
 * it moved their scores.
 *
 * ## Why this is a hook and not a hermeticity fix
 *
 * The obvious fix — don't give children the host's hooks — has no lever:
 *
 *   · Hooks MERGE across settings tiers. Probed 2026-08-18: a project-tier
 *     `SessionStart` hook still fired with `--settings '{"hooks":{}}'` layered
 *     above it, which is the highest (CLI-args) tier. A settings overlay cannot
 *     clear an inherited hook.
 *   · `--bare` does skip hooks, but also skips CLAUDE.md auto-discovery, plugin
 *     sync and auto-memory, and defers the MCP connection past `system/init`.
 *     Team children need their project context and MCP tools.
 *   · A clean `CLAUDE_CONFIG_DIR` loses the user's MCP servers and plugins for
 *     the same reason.
 *
 * So the context is going to arrive. What claudish can change is what the model
 * DOES with it. Following the supervisor's design rule ("put the fact where the
 * decision is made"), this states the convention in the system prompt, where
 * the model decides how to open its answer. It is deliberately NOT a post-hoc
 * filter on the response: there is no reliable way to tell "boilerplate the
 * model echoed" from "the user's own words quoted legitimately", and a wrong
 * strip would delete real content from a deliverable.
 *
 * The note is applied at stage A, BEFORE message conversion, so it reaches every
 * route. The behavior rule appended it after `convertMessagesToOpenAI` had
 * already copied the system prompt into `messages[0]`, and chat-completions
 * adapters build their payload from `messages` alone, so on OpenRouter and the
 * OpenAI chat wire it was silently dropped (decisions.md, 2026-10-09).
 */

import { type RequestAction, type RequestContext, act } from "../public.js";
import type { BuiltinHook } from "../registry.js";

export const SESSION_CONTEXT_HOOK_ID = "session-context/no-harness-echo";

/**
 * How Claude Code labels hook-injected context. Taken from CC 2.1.233's own
 * wording; matched case-insensitively and loosely so a phrasing tweak degrades
 * to "hook stands down", never to a false positive on user prose.
 */
const SESSION_CONTEXT_MARKERS = ["sessionstart hook additional context", "hook additional context"];

/** Does this request actually carry injected session context? */
export function hasInjectedSessionContext(
  systemText: string,
  messages: ReadonlyArray<unknown>
): boolean {
  const haystacks: string[] = [systemText ?? ""];

  // CC may place the hook context in the first user turn rather than the system
  // prompt, so check both — but only the FIRST message, because scanning a long
  // conversation would match the model's own earlier echo and re-arm forever.
  const first = Array.isArray(messages) ? messages[0] : undefined;
  if (first && typeof first === "object") {
    const content = (first as { content?: unknown }).content;
    if (typeof content === "string") {
      haystacks.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const text = (block as { text?: unknown } | null)?.text;
        if (typeof text === "string") haystacks.push(text);
      }
    }
  }

  return haystacks.some((h) => {
    const lower = h.toLowerCase();
    return SESSION_CONTEXT_MARKERS.some((m) => lower.includes(m));
  });
}

export const SESSION_CONTEXT_NOTE =
  "Operational context note. This session may include text injected by the harness " +
  "itself — SessionStart hook output, coaching or insight blocks, tooling banners, " +
  "status lines. That material is addressed to you, not to the user, and it is not " +
  "part of the task. Never reproduce, summarise, or quote it in your answer, and never " +
  "let it open your response. Begin your answer with the requested deliverable and " +
  "nothing before it.";

/** The request handler, exported for unit tests. */
export function sessionContextRequest(ctx: RequestContext): RequestAction[] {
  if (!hasInjectedSessionContext(ctx.request.systemText, ctx.request.messages)) return [];
  return [act.injectSystemNote(SESSION_CONTEXT_NOTE)];
}

export const sessionContextHook: BuiltinHook = {
  apiVersion: 1,
  id: SESSION_CONTEXT_HOOK_ID,
  description:
    "Stop foreign models opening their answer with harness-injected session context " +
    "(SessionStart hook output, coaching/insight blocks).",
  defaultSeverity: "fix",
  // Native Claude treats this context as operational already; the measured
  // failures were foreign models only.
  routes: "foreign",
  on: { request: sessionContextRequest },
};
