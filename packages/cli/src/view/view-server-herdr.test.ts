import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { replayItem } from "../herdr/test-helpers/view-items.js";
import type { ReplayViewItem } from "../pane/view-contract.js";
import { makeViewRoot } from "./test-helpers/fake-view-endpoint.js";
import { ViewClaims } from "./view-claims.js";
import { ViewClient } from "./view-client.js";
import { ViewDirectory } from "./view-directory.js";
import { ViewFeed } from "./view-feed.js";
import { ViewServer } from "./view-server.js";

let stop: Array<() => void> = [];
afterEach(() => {
  for (const s of stop.reverse()) s();
  stop = [];
});

async function serve() {
  const root = `/tmp/vsh-${randomBytes(4).toString("hex")}`;
  makeViewRoot(root);
  const replay = replayItem("replay-1") as ReplayViewItem;
  const { view: _v, ...listed } = replay;
  const feed = new ViewFeed();
  const claims = new ViewClaims();
  const directory = new ViewDirectory({
    sessions: {
      sessionRow: () => null,
      viewDetail: () => null,
      listSessionRows: () => [],
      captureSession: () => {
        throw new Error("unused");
      },
      transcriptSession: () => {
        throw new Error("unused");
      },
      resizeSession: async () => {
        throw new Error("unused");
      },
    },
    team: {
      listSlots: () => [],
      slot: () => null,
      capture: () => {
        throw new Error("unused");
      },
      transcript: () => {
        throw new Error("unused");
      },
      resize: async () => {
        throw new Error("unused");
      },
    },
    replays: {
      list: () => [listed],
      capture: () => {
        throw new Error("unused");
      },
      resize: async () => {
        throw new Error("unused");
      },
    },
    claims,
  });
  feed.setBuilder((t) => directory.item(t));
  const server = await ViewServer.start({
    root,
    directory,
    claims,
    feed,
    version: "test",
    frontEnd: "herdr",
  });
  if (!server) throw new Error("no endpoint");
  stop.push(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { server, directory };
}

describe("ViewServer in a herdr pane", () => {
  test("a herdr viewer's hello is answered with this server's front end, and it lists the replay", async () => {
    const { server } = await serve();
    const client = await ViewClient.connect(server.endpointPath, {
      hello: { name: "claudish view", kind: "viewer", front_end: "herdr" },
    });
    expect(client.helloResult?.server.front_end).toBe("herdr");
    const { items } = await client.request<{ items: Array<{ target: string }> }>("list", {});
    expect(items.map((i) => i.target)).toEqual(["r:replay-1"]);
    client.close();
  });
});
