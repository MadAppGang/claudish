/**
 * The system prompt and the tool declarations the Antigravity CLI (`agy` 1.5.9,
 * recorded 2026-11-17) sends, and how an Antigravity request carries them.
 *
 * `antigravity-agy-request.json` holds both as recorded. The prompt is a
 * template: the lists that came from the recording machine (MCP servers,
 * plugin subagents, skills) are empty, and the values of
 * `<user_information>` are placeholders filled per request.
 *
 * A request that declares tools is sent as `agy` sends an agent request:
 *
 * - the system text is `agy`'s prompt, then the harness's own text;
 * - the tools are `agy`'s 17 declarations in `agy`'s order, then the harness's
 *   other tools.
 *
 * Seven of the 17 are tools Claude Code runs (the tool-name alias renames them
 * and translates their arguments). The other ten have nothing behind them: a
 * call to one reaches Claude Code under its `agy` name, and Claude Code answers
 * that it has no such tool.
 *
 * A request with no tools (a title, a summary) is left as it is: `agy` sends
 * those with no system prompt and no tools.
 */

import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ANTIGRAVITY_IDENTITY_HEAD } from "../handlers/shared/format/identity-filter.js";
import recorded from "./antigravity-agy-request.json";

interface Declaration {
  name: string;
  description?: string;
  [key: string]: unknown;
}

const DECLARATIONS = recorded.tools as Declaration[];
const BY_NAME = new Map(DECLARATIONS.map((declaration) => [declaration.name, declaration]));

/** The values `agy` writes into its prompt and its `run_command` description. */
export interface AgyEnvironment {
  /** `mac` on macOS, as recorded. */
  os: string;
  shell: string;
  workspace: string;
  appDataDir: string;
}

const OS_NAME: Record<string, string> = { darwin: "mac", win32: "windows" };

/**
 * The environment of this process. `appDataDir` is a directory of claudish's
 * own and not `agy`'s (`~/.gemini/antigravity-cli`): the prompt tells the model
 * to write artifacts under it, and `agy` keeps its conversations there.
 */
export function agyEnvironment(): AgyEnvironment {
  return {
    os: OS_NAME[process.platform] ?? process.platform,
    shell: basename(process.env.SHELL || "sh"),
    workspace: process.cwd(),
    appDataDir: join(homedir(), ".claudish", "antigravity"),
  };
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}

/** A declaration as recorded, placeholders unfilled. Undefined for a name `agy` does not declare. */
export function agyDeclarationTemplate(name: string): Declaration | undefined {
  return BY_NAME.get(name);
}

/** `agy`'s system prompt for one conversation. */
export function agySystemText(environment: AgyEnvironment, conversationId: string): string {
  return fill(recorded.system, { ...environment, conversationId });
}

type ToolEntry = { functionDeclarations?: unknown } & Record<string, unknown>;

function declarationsOf(tools: unknown): Declaration[] {
  if (!Array.isArray(tools)) return [];
  const out: Declaration[] = [];
  for (const entry of tools as Array<ToolEntry | null>) {
    if (!Array.isArray(entry?.functionDeclarations)) continue;
    for (const declaration of entry.functionDeclarations as Declaration[]) {
      if (typeof declaration?.name === "string") out.push(declaration);
    }
  }
  return out;
}

/** Whether the request declares a tool, which makes it an agent request. */
export function declaresTools(tools: unknown): boolean {
  return declarationsOf(tools).length > 0;
}

/**
 * The request's tools with `agy`'s declarations first.
 *
 * A declaration of the request under an `agy` name is replaced by `agy`'s only
 * when it carries `agy`'s description, which the tool-name alias puts on the
 * tools it renamed. Any other declaration under such a name is a tool of the
 * user's own: it is kept, and `agy`'s declaration of that name is not sent,
 * since a name can be declared once.
 */
export function withAgyTools(tools: unknown, environment: AgyEnvironment): unknown {
  const own = declarationsOf(tools);
  if (own.length === 0) return tools;
  const ownByName = new Map(own.map((declaration) => [declaration.name, declaration]));
  const values = { ...environment };
  const replaced = new Set<string>();
  const out: unknown[] = [];
  for (const declaration of DECLARATIONS) {
    const mine = ownByName.get(declaration.name);
    if (mine !== undefined && mine.description !== declaration.description) continue;
    if (mine !== undefined) replaced.add(declaration.name);
    out.push({
      functionDeclarations: [
        declaration.description === undefined
          ? declaration
          : { ...declaration, description: fill(declaration.description, values) },
      ],
    });
  }
  for (const entry of tools as Array<ToolEntry | null>) {
    if (!Array.isArray(entry?.functionDeclarations)) {
      out.push(entry);
      continue;
    }
    const { functionDeclarations, ...rest } = entry;
    // An entry that declares nothing can still hold another capability.
    if (functionDeclarations.length === 0 && Object.keys(rest).length > 0) out.push(rest);
    for (const declaration of functionDeclarations as Declaration[]) {
      if (replaced.has(declaration?.name)) continue;
      // A renamed tool whose description something changed after the alias
      // (a hook) is kept as it is. Where it still holds `agy`'s description,
      // that part has its placeholders filled; no other text is touched.
      const template = BY_NAME.get(declaration?.name)?.description;
      const kept =
        template && typeof declaration.description === "string"
          ? {
              ...declaration,
              description: declaration.description.replace(template, () => fill(template, values)),
            }
          : declaration;
      out.push({ ...rest, functionDeclarations: [kept] });
    }
  }
  return out;
}

/**
 * The system instruction with `agy`'s prompt first, in one part as recorded.
 * The two-line Antigravity identity the scrub put at the head of the harness's
 * text is removed: `agy`'s prompt opens with its own `<identity>` block.
 */
export function withAgySystem(
  systemInstruction: unknown,
  environment: AgyEnvironment,
  conversationId: string
): Record<string, unknown> {
  const instruction =
    systemInstruction && typeof systemInstruction === "object"
      ? (systemInstruction as Record<string, unknown>)
      : {};
  const parts = Array.isArray(instruction.parts) ? instruction.parts : [];
  let own = parts
    .map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n\n");
  if (own.startsWith(ANTIGRAVITY_IDENTITY_HEAD)) {
    own = own.slice(ANTIGRAVITY_IDENTITY_HEAD.length).trimStart();
  }
  const text = agySystemText(environment, conversationId);
  return { ...instruction, parts: [{ text: own ? `${text}\n${own}` : text }] };
}
