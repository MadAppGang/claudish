import { describe, expect, test } from "bun:test";
import { PlacementGrants, placementToken } from "./placement-grants.js";

const T = "r:replay-1";
const W = "0123abcd/w1";

describe("PlacementGrants", () => {
  test("one grant per workspace; another workspace gets its own", () => {
    const g = new PlacementGrants();
    expect(g.grant(T, W, "mcp", "t1")).toBe(true);
    expect(g.grant(T, W, "conn-2", "t2")).toBe(false);
    expect(g.grant(T, "0123abcd/w2", "conn-2", "t3")).toBe(true);
    expect(g.workspaces(T)).toEqual([W, "0123abcd/w2"].sort());
  });

  test("a connected herdr viewer in the workspace refuses a grant", () => {
    const g = new PlacementGrants();
    g.viewerSubscribed(T, "conn-v", W, null);
    expect(g.grant(T, W, "mcp", "t1")).toBe(false);
    g.connectionGone("conn-v");
    expect(g.grant(T, W, "mcp", "t1")).toBe(true);
  });

  test("a viewer of an abandoned attempt neither ends the reservation nor frees the workspace when it goes", () => {
    const g = new PlacementGrants();
    expect(g.grant(T, W, "mcp", "t1")).toBe(true);
    g.attempt("t1", "a1");
    g.viewerSubscribed(T, "conn-v1", W, placementToken("t1", "a1"));
    g.attempt("t1", "a2");
    g.connectionGone("conn-v1");
    expect(g.pending("t1")).toBe(true);
    expect(g.grant(T, W, "conn-c", "t9")).toBe(false);
  });

  test("the reservation ends when the transaction is placed and its current attempt's viewer is connected, in either order", () => {
    for (const order of ["placed-first", "viewer-first"] as const) {
      const g = new PlacementGrants();
      g.grant(T, W, "mcp", "t1");
      g.attempt("t1", "a1");
      if (order === "placed-first") g.placed("t1");
      g.viewerSubscribed(T, "conn-v", W, placementToken("t1", "a1"));
      if (order === "viewer-first") {
        expect(g.pending("t1")).toBe(true);
        g.placed("t1");
      }
      expect(g.pending("t1")).toBe(false);
      // the viewer's presence keeps the workspace now
      expect(g.grant(T, W, "conn-c", "t2")).toBe(false);
    }
  });

  test("a viewer the user started never ends a reservation", () => {
    const g = new PlacementGrants();
    g.grant(T, W, "mcp", "t1");
    g.attempt("t1", "a1");
    g.placed("t1");
    g.viewerSubscribed(T, "conn-hand", W, null);
    expect(g.pending("t1")).toBe(true);
  });

  test("done and the owner's connection closing end a reservation", () => {
    const g = new PlacementGrants();
    g.grant(T, W, "mcp", "t1");
    g.done("t1");
    expect(g.workspaces(T)).toEqual([]);
    g.grant(T, W, "conn-peer", "t2");
    g.connectionGone("conn-peer");
    expect(g.workspaces(T)).toEqual([]);
    g.done("t2");
  });

  test("notify fires on each change of a target's workspaces", () => {
    const seen: string[] = [];
    const g = new PlacementGrants({ notify: (t) => seen.push(t) });
    g.grant(T, W, "mcp", "t1");
    g.done("t1");
    expect(seen).toEqual([T, T]);
  });
});
