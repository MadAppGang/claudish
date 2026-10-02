/**
 * The parent proof's project-directory cache must never hold a wrong answer.
 *
 * A wrong entry lives for the MCP server's whole life: every later call for
 * that conversation searches the wrong place and `parentClaudeSessionId` stays
 * absent, even for transcripts that hold the tool-use id. Two ways in: a
 * DIRECTORY named `<id>.jsonl` (a bare `stat` is true for it), and a cached
 * directory that no longer holds the transcript.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { type ProjectDirCache, type ProofFs, proveCallingConversation } from "./parent-proof.js";

const CONFIG = "/cfg";
const PROJECTS = join(CONFIG, "projects");
const SESSION = "11111111-2222-3333-4444-555555555555";
const TOOL_USE = "toolu_01ABCDEFGHJKLMNP";

type Node = { kind: "dir" } | { kind: "file"; content: string; mtimeMs: number };

/** An in-memory filesystem: absolute path → node. Parents are implied by paths. */
function memoryFs(nodes: Map<string, Node>): ProofFs {
  const get = (path: string): Node => {
    const node = nodes.get(path);
    if (node) return node;
    // A path that is a prefix of another is an implied directory.
    for (const key of nodes.keys()) if (key.startsWith(`${path}/`)) return { kind: "dir" };
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  };
  return {
    readFile: async (path) => {
      const node = get(path);
      if (node.kind !== "file") throw new Error(`EISDIR: ${path}`);
      return node.content;
    },
    readdir: async (path) => {
      if (get(path).kind !== "dir") throw new Error(`ENOTDIR: ${path}`);
      const names = new Set<string>();
      for (const key of nodes.keys()) {
        if (key.startsWith(`${path}/`)) names.add(key.slice(path.length + 1).split("/")[0]);
      }
      return [...names].sort();
    },
    stat: async (path) => {
      const node = get(path);
      return {
        mtimeMs: node.kind === "file" ? node.mtimeMs : 0,
        size: node.kind === "file" ? Buffer.byteLength(node.content) : 0,
        isDirectory: () => node.kind === "dir",
        isFile: () => node.kind === "file",
      };
    },
    open: async (path) => {
      const node = get(path);
      if (node.kind !== "file") throw new Error(`EISDIR: ${path}`);
      const bytes = Buffer.from(node.content, "utf-8");
      return {
        read: async (buffer, offset, length, position) => {
          const n = bytes.copy(buffer, offset, position, position + length);
          return { bytesRead: n };
        },
        close: async () => {},
      };
    },
  };
}

const transcript = (): Node => ({
  kind: "file",
  content: `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"${TOOL_USE}"}]}}\n`,
  mtimeMs: 0,
});

function prove(fs: ProofFs, cache: ProjectDirCache, cwd?: string): Promise<string | undefined> {
  return proveCallingConversation({
    toolUseId: TOOL_USE,
    candidates: [{ sessionId: SESSION, ...(cwd ? { cwd } : {}) }],
    configDir: CONFIG,
    fs,
    cache,
    sleep: async () => {},
    now: () => 0,
  });
}

describe("parent proof project-directory cache", () => {
  test("a directory named <id>.jsonl is not the transcript (listing path)", async () => {
    // `-a` lists before `-b`, so a bare existence check stops at the decoy.
    const nodes = new Map<string, Node>([
      [join(PROJECTS, "-a", `${SESSION}.jsonl`, "x"), { kind: "file", content: "", mtimeMs: 0 }],
      [join(PROJECTS, "-b", `${SESSION}.jsonl`), transcript()],
    ]);
    const cache: ProjectDirCache = new Map();
    expect(await prove(memoryFs(nodes), cache)).toBe(SESSION);
    expect([...cache.values()]).toEqual([join(PROJECTS, "-b")]);
  });

  test("a directory named <id>.jsonl on the fast path falls through to the listing", async () => {
    const cwd = "/work/repo";
    const nodes = new Map<string, Node>([
      [
        join(PROJECTS, "-work-repo", `${SESSION}.jsonl`, "x"),
        { kind: "file", content: "", mtimeMs: 0 },
      ],
      [join(PROJECTS, "-z", `${SESSION}.jsonl`), transcript()],
    ]);
    const cache: ProjectDirCache = new Map();
    expect(await prove(memoryFs(nodes), cache, cwd)).toBe(SESSION);
  });

  test("a fast-path hit is not cached", async () => {
    const cwd = "/work/repo";
    const nodes = new Map<string, Node>([
      [join(PROJECTS, "-work-repo", `${SESSION}.jsonl`), transcript()],
    ]);
    const cache: ProjectDirCache = new Map();
    expect(await prove(memoryFs(nodes), cache, cwd)).toBe(SESSION);
    expect(cache.size).toBe(0);
  });

  test("a cached directory that lost the transcript is resolved again", async () => {
    const nodes = new Map<string, Node>([
      [join(PROJECTS, "-old", `${SESSION}.jsonl`), transcript()],
    ]);
    const fs = memoryFs(nodes);
    const cache: ProjectDirCache = new Map();
    expect(await prove(fs, cache)).toBe(SESSION);

    // The conversation's transcript now lives in another project directory.
    nodes.delete(join(PROJECTS, "-old", `${SESSION}.jsonl`));
    nodes.set(join(PROJECTS, "-old", "other.jsonl"), { kind: "file", content: "", mtimeMs: 0 });
    nodes.set(join(PROJECTS, "-new", `${SESSION}.jsonl`), transcript());

    expect(await prove(fs, cache)).toBe(SESSION);
    expect([...cache.values()]).toEqual([join(PROJECTS, "-new")]);
  });
});
