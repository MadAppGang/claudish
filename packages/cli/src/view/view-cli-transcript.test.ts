/**
 * `claudish view --transcript <target>`: the conversation of a session or slot as text lines, read
 * from whichever live server holds the target. The Herdr.app mod cannot open a socket, so this is
 * how its Text tab reads a transcript.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { sessionItem } from "../herdr/test-helpers/view-items.js";
import { ContractErrorException } from "../pane/contract.js";
import { makeViewRoot } from "./test-helpers/fake-view-endpoint.js";
import { ViewClaims } from "./view-claims.js";
import { parseTranscriptArgs, transcriptOf } from "./view-cli.js";
import { ViewDirectory } from "./view-directory.js";
import { ViewFeed } from "./view-feed.js";
import { ViewServer } from "./view-server.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop();
});

const absent = (): never => {
  throw new ContractErrorException("unknown_run", "no such run");
};

async function serverWith(sessionIds: string[]): Promise<string> {
  const root = `/tmp/vct-${randomBytes(4).toString("hex")}`;
  makeViewRoot(root);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const feed = new ViewFeed({ debounceMs: 5 });
  const claims = new ViewClaims({ notify: (t) => feed.changed(t, true) });
  const directory = new ViewDirectory({
    sessions: {
      sessionRow: () => null,
      viewDetail: () => null,
      listSessionRows: () => sessionIds.map((id) => sessionItem(id) as never),
      captureSession: absent,
      transcriptSession: (id, since) => {
        if (!sessionIds.includes(id))
          throw new ContractErrorException("unknown_session", `no session ${id}`);
        return {
          session_id: id,
          cursor: since ? "v1.20.1.bbbbbbbb" : "v1.10.1.aaaaaaaa",
          lines: [
            { kind: "user", text: "Read view-claims.ts" },
            { kind: "assistant", text: since ? "the rest" : "One holder per target." },
          ],
          more: false,
          final: true,
        };
      },
      resizeSession: async () => absent(),
    },
    team: {
      listSlots: () => [],
      slot: () => null,
      capture: absent,
      transcript: absent,
      resize: async () => absent(),
    },
    replays: { list: () => [], capture: absent, resize: async () => absent() },
    claims,
  });
  feed.setBuilder((t) => directory.item(t));
  const server = await ViewServer.start({ root, directory, claims, feed, version: "test" });
  if (!server) throw new Error("test server failed to bind");
  cleanups.push(() => server.close());
  return root;
}

describe("claudish view --transcript", () => {
  test("parses a target and an optional cursor; anything else is refused", () => {
    expect(parseTranscriptArgs(["--transcript", "s:a"])).toEqual({ target: "s:a" });
    expect(parseTranscriptArgs(["--transcript", "t:run-1/02", "--since", "v1.1.0.x"])).toEqual({
      target: "t:run-1/02",
      since: "v1.1.0.x",
    });
    expect(parseTranscriptArgs(["--transcript"])).toEqual({ error: "a target is required" });
    expect(parseTranscriptArgs(["--transcript", "s:a", "--since"])).toEqual({
      error: "--since needs a cursor",
    });
    expect(parseTranscriptArgs(["--transcript", "s:a", "--bogus"])).toEqual({
      error: "unknown option --bogus",
    });
  });

  test("answers the holding server's transcript, the cursor passed through", async () => {
    const root = await serverWith(["a"]);
    const first = await transcriptOf(root, "s:a");
    expect(first).toEqual({
      ok: true,
      result: {
        session_id: "a",
        cursor: "v1.10.1.aaaaaaaa",
        lines: [
          { kind: "user", text: "Read view-claims.ts" },
          { kind: "assistant", text: "One holder per target." },
        ],
        more: false,
        final: true,
      },
    });
    const next = await transcriptOf(root, "s:a", "v1.10.1.aaaaaaaa");
    expect(next.ok && next.result.lines[1]?.text).toBe("the rest");
  });

  test("a target no live server holds answers the server's own error", async () => {
    const root = await serverWith(["a"]);
    const missing = await transcriptOf(root, "s:zz");
    expect(missing).toEqual({
      ok: false,
      error: { code: "unknown_session", message: "no session zz" },
    });
  });

  test("with no server at all the answer says so", async () => {
    const root = `/tmp/vct-${randomBytes(4).toString("hex")}`;
    makeViewRoot(root);
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    expect(await transcriptOf(root, "s:a")).toEqual({
      ok: false,
      error: { code: "server_gone", message: "no claudish MCP server is running" },
    });
  });
});
