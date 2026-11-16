/**
 * Writes `src/providers/antigravity-agy-request.json` from a recording of the
 * Antigravity CLI: its system prompt as a template and its tool declarations as
 * recorded.
 *
 * The recording is a JSON Lines file with one object per HTTP exchange,
 * `{ url, request_body }`, as a mitmproxy export addon writes it. The first
 * `streamGenerateContent` request that declares tools is used.
 *
 * What came from the recording machine is taken out: the MCP servers, the
 * skills and the plugin subagents are removed, and the values of
 * `<user_information>` and of `run_command`'s description become placeholders.
 * The run fails if a home directory path is left in the output.
 *
 * usage: bun run scripts/generate-agy-request.ts <recording.jsonl>
 * then:  bunx biome format --write src/providers/antigravity-agy-request.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Declaration {
  name: string;
  description?: string;
}

interface AgentRequest {
  systemInstruction: { parts: Array<{ text: string }> };
  tools: Array<{ functionDeclarations?: Declaration[] }>;
}

function firstAgentRequest(path: string): AgentRequest {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes("streamGenerateContent")) continue;
    const exchange = JSON.parse(line) as { url: string; request_body: string };
    if (!exchange.url.includes("streamGenerateContent")) continue;
    const request = (JSON.parse(exchange.request_body) as { request: AgentRequest }).request;
    if (Array.isArray(request.tools) && request.tools.length > 0) return request;
  }
  throw new Error("no streamGenerateContent request with tools in the recording");
}

/** `text` without what lies between the end of `from` and the start of `to`. */
function emptyBetween(text: string, from: string, to: string, keep = ""): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`section not found: ${from}`);
  return text.slice(0, start + from.length) + keep + text.slice(end);
}

const recording = process.argv[2];
if (!recording) throw new Error("usage: generate-agy-request.ts <recording.jsonl>");
const request = firstAgentRequest(recording);

let system = request.systemInstruction.parts.map((part) => part.text).join("\n");
// The format example of the MCP section ends with a code fence; the servers follow it.
system = emptyBetween(system, "Lazy:\n<toolName>\n```\n", "</mcp_servers>");
// The subagent list is the lines up to the first empty one; `self` and `research` are built in.
const listAt = system.indexOf("Available subagents:\n") + "Available subagents:\n".length;
const listEnd = system.indexOf("\n\n", listAt) + 1;
const builtIn = system
  .slice(listAt, listEnd)
  .split("\n")
  .filter((line) => line.startsWith("- self:") || line.startsWith("- research:"));
system = `${system.slice(0, listAt)}${builtIn.join("\n")}\n${system.slice(listEnd)}`;
system = emptyBetween(system, "Available skills:\n", "</skills>", "\n\n");
const informationAt = system.indexOf("<user_information>");
const information = system
  .slice(informationAt)
  .replace(/OS version is \S+\./, "OS version is {{os}}.")
  .replace(/(Active Workspaces:\n- ).*/, "$1{{workspace}}")
  .replace(/(Command Working Directory: ).*/, "$1{{workspace}}")
  .replace(/(App Data Directory: ).*/, "$1{{appDataDir}}")
  .replace(/(Conversation ID: ).*/, "$1{{conversationId}}")
  .replace(/(Artifact Directory Path: ).*/, "$1{{appDataDir}}/brain/{{conversationId}}");
system = system.slice(0, informationAt) + information;

const tools = request.tools.flatMap((entry) => entry.functionDeclarations ?? []);
for (const declaration of tools) {
  if (declaration.name !== "run_command" || !declaration.description) continue;
  declaration.description = declaration.description.replace(
    /Operating System: \S+\. Shell: \S+\./,
    "Operating System: {{os}}. Shell: {{shell}}."
  );
}

const output = `${JSON.stringify({ system, tools }, null, 2)}\n`;
for (const local of ["/Users/", "/home/", "C:\\\\Users"]) {
  if (output.includes(local)) throw new Error(`a local path is left in the output: ${local}`);
}
const target = join(import.meta.dir, "..", "src", "providers", "antigravity-agy-request.json");
writeFileSync(target, output);
console.log(`wrote ${target}: ${system.length} characters of system text, ${tools.length} tools`);
