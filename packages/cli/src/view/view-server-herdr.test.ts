import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { PlacementGrants, placementToken } from "../herdr/placement-grants.js";
import { replayItem } from "../herdr/test-helpers/placer-harness.js";
import type { ReplayViewItem } from "../pane/view-contract.js";
import { makeViewRoot } from "./test-helpers/fake-view-endpoint.js";
import { ViewClaims } from "./view-claims.js";
import { ViewClient } from "./view-client.js";
import { ViewDirectory } from "./view-directory.js";
import { ViewFeed } from "./view-feed.js";
import { ViewServer } from "./view-server.js";

const KEY = "0123abcd/w1";
let stop: Array<() => void> = [];
afterEach(() => {
  for (const s of stop.reverse()) s();
  stop = [];
});

async function serve(grants: PlacementGrants) {
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
    herdrWorkspaces: (t) => grants.workspaces(t),
  });
  feed.setBuilder((t) => directory.item(t));
  const server = await ViewServer.start({
    root,
    directory,
    claims,
    feed,
    version: "test",
    frontEnd: "herdr",
    workspaceId: () => "w1",
    herdrViewers: grants,
  });
  if (!server) throw new Error("no endpoint");
  stop.push(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { server, directory };
}

describe("ViewServer: herdr viewers and placement grants", () => {
  test("a placed herdr viewer's subscribe and its disconnect reach the grants; its hello is answered with this server's front end", async () => {
    const grants = new PlacementGrants();
    const { server, directory } = await serve(grants);
    expect(grants.grant("r:replay-1", KEY, "mcp", "t1")).toBe(true);
    grants.attempt("t1", "a1");
    grants.placed("t1");
    const client = await ViewClient.connect(server.endpointPath, {
      hello: {
        name: "claudish view",
        kind: "viewer",
        front_end: "herdr",
        workspace_key: KEY,
        placement: placementToken("t1", "a1"),
      },
    });
    expect(client.helloResult?.server.front_end).toBe("herdr");
    expect(client.helloResult?.server.workspace_id).toBe("w1");
    await client.request("subscribe", { targets: ["r:replay-1"] });
    expect(grants.pending("t1")).toBe(false);
    expect(directory.item("r:replay-1")).toMatchObject({ herdr_workspaces: [KEY] });
    client.close();
    for (let i = 0; i < 50 && grants.workspaces("r:replay-1").length > 0; i++) await Bun.sleep(10);
    expect(grants.workspaces("r:replay-1")).toEqual([]);
  });

  test("a viewer with a malformed workspace key or a plain front end is not counted", async () => {
    const grants = new PlacementGrants();
    const { server } = await serve(grants);
    for (const hello of [
      { front_end: "herdr" as const, workspace_key: "../../etc" },
      { front_end: "none" as const, workspace_key: KEY },
    ]) {
      const c = await ViewClient.connect(server.endpointPath, {
        hello: { name: "v", kind: "viewer", ...hello },
      });
      await c.request("subscribe", { targets: ["r:replay-1"] });
      expect(grants.workspaces("r:replay-1")).toEqual([]);
      c.close();
    }
  });
});
