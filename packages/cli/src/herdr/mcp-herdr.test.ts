import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr } from "../pane/test-helpers/fake-herdr.js";
import { assertHermetic, makeFakeHerdrEnv } from "../pane/test-helpers/hermetic-env.js";
import { chooseFrontEnd } from "../view/view-cli.js";
import { PLAIN_TERMINAL } from "../view/viewer.js";
import { startMcpHerdrPlacer } from "./mcp-herdr.js";
import { PlacementGrants } from "./placement-grants.js";
import { HandFeed, sessionItem } from "./test-helpers/placer-harness.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mcp-herdr-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function deps(env: Record<string, string | undefined>, root: string) {
  return {
    env,
    root,
    feed: new HandFeed(),
    item: () => sessionItem("a"),
    grants: new PlacementGrants(),
    endpoint: () => null,
    cwd: root,
    log: () => {},
  };
}

describe("no herdr call outside herdr", () => {
  test("an MCP server whose env lacks HERDR_* builds no placer and never dials herdr", async () => {
    const fake = await FakeHerdr.start();
    cleanups.push(() => fake.stop());
    const env = { PATH: "/usr/bin", HOME: "/tmp/h", TERM_PROGRAM: "iTerm.app" };
    expect(await startMcpHerdrPlacer(deps(env, tmp()))).toBeNull();
    // TERM_PROGRAM=herdr alone, or the socket alone, is not a herdr pane either
    expect(
      await startMcpHerdrPlacer(
        deps({ TERM_PROGRAM: "herdr", HERDR_SOCKET_PATH: fake.path }, tmp())
      )
    ).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  test("a viewer outside herdr gets the plain terminal and never dials herdr", async () => {
    const fake = await FakeHerdr.start();
    cleanups.push(() => fake.stop());
    const placed = { placed: false, endpoint: undefined, placement: undefined };
    const choice = await chooseFrontEnd("auto", { HERDR_SOCKET_PATH: fake.path }, placed);
    expect(choice).toEqual({ frontEnd: PLAIN_TERMINAL });
    expect(await chooseFrontEnd("herdr", {}, placed)).toHaveProperty("error");
    expect(fake.calls).toHaveLength(0);
  });

  test("inside a (fake) herdr pane the placer starts in that pane's workspace", async () => {
    const dir = tmp();
    const { fake, env, paneId } = await makeFakeHerdrEnv(dir);
    cleanups.push(() => fake.stop());
    const placer = await startMcpHerdrPlacer(deps(env, dir));
    if (!placer) throw new Error("no placer in a herdr pane");
    cleanups.push(() => placer.shutdown());
    expect(fake.callsOf("pane.get")[0]?.params).toEqual({ pane_id: paneId });
    expect(placer.workspace).toBe("w1");
  });
});

describe("assertHermetic and herdr", () => {
  const base = { HOME: "/tmp/h", CLAUDE_CONFIG_DIR: "/tmp/h/.claude", ZDOTDIR: "/tmp/h" };
  const realHome = require("node:os").homedir() as string;

  test.each([
    [
      "the default herdr session's socket",
      "HERDR_SOCKET_PATH",
      `${realHome}/.config/herdr/herdr.sock`,
    ],
    [
      "a named herdr session's socket",
      "HERDR_SOCKET_PATH",
      `${realHome}/.config/herdr/sessions/x/herdr.sock`,
    ],
    [
      "a herdr-core terminal socket",
      "HC_TERMINAL_SOCKET",
      `${realHome}/.local/state/herdr-core/default/t.sock`,
    ],
    ["HC_SOCKET under the real home", "HC_SOCKET", `${realHome}/.local/state/herdr-core/s.sock`],
  ])("refuses %s", (_name, key, value) => {
    expect(() => assertHermetic({ ...base, [key]: value })).toThrow(/real multiplexer socket/);
  });

  test("accepts a fake herdr socket in a temp dir", () => {
    expect(() => assertHermetic({ ...base, HERDR_SOCKET_PATH: "/tmp/x/herdr.sock" })).not.toThrow();
  });
});
