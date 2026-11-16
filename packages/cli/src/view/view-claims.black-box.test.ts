import { afterEach, describe, expect, test } from "bun:test";
import { type ClaimCaller, ViewClaims } from "./view-claims.js";

const target = "s:alpha";
const mcp: ClaimCaller = { kind: "mcp" };
const peer: ClaimCaller = { kind: "conn", role: "peer", connId: "peer" };
const otherPeer = (id: string): ClaimCaller => ({ kind: "conn", role: "peer", connId: id });
const viewer = (id: string): ClaimCaller => ({ kind: "conn", role: "viewer", connId: id });
const cleanup: ViewClaims[] = [];
afterEach(() => {
  for (const claims of cleanup.splice(0)) {
    for (const t of [target, "s:beta", "r:replay-a"]) claims.forget(t);
  }
});
function registry(now?: () => number): ViewClaims {
  const c = new ViewClaims({ now });
  cleanup.push(c);
  return c;
}

describe("active view claims", () => {
  test.each([
    [mcp, "claude_code", "claude_code"],
    [peer, "claude_code", "claude_code_other"],
  ] as const)("TEST-6 REQ-11 derives holder from caller %j", (caller, absolute, relative) => {
    const claims = registry();

    const grant = claims.claim(target, caller);

    expect(grant.holder).toBe(absolute);
    expect(claims.holder(target)).toEqual(grant);
    expect(claims.holderForMcp(target)?.holder).toBe(relative);
    expect(claims.holds(target, caller)).toBe(true);
    expect(Number.isFinite(Date.parse(grant.since))).toBe(true);
    expect(grant.claim_id.length).toBeGreaterThan(0);
  });

  test("a viewer only watches: its claim is refused and the Claude Code holder stays", () => {
    const claims = registry();
    const existing = claims.claim(target, mcp);

    expect(() => claims.claim(target, viewer("a"))).toThrow(/only watches/);
    expect(() => claims.claim("s:beta", viewer("a"))).toThrow(/only watches/);

    expect(claims.holder(target)).toEqual(existing);
    expect(claims.holder("s:beta")).toBeNull();
  });

  test("TEST-7 REQ-11 REQ-12 latest act wins, per target", () => {
    let now = 1_000;
    const claims = registry(() => now);
    const first = claims.claim(target, mcp);
    const independent = claims.claim("s:beta", mcp);
    now += 1;

    const second = claims.claim(target, peer);

    expect(second.claim_id).not.toBe(first.claim_id);
    expect(second.since).not.toBe(first.since);
    expect(claims.holds(target, mcp)).toBe(false);
    expect(claims.holder(target)).toEqual(second);
    expect(claims.holder("s:beta")).toEqual(independent);
  });

  test.each([
    [mcp, 10_000],
    [peer, 10_000],
  ] as const)("TEST-8 REQ-12 REQ-32 expires caller %j at %i ms, not before", (caller, ttl) => {
    let now = 1_000;
    const claims = registry(() => now);
    const first = claims.claim(target, caller);
    now += ttl - 1;
    expect(claims.holder(target)).toEqual(first);

    now += 1;

    expect(claims.holder(target)).toBeNull();
    expect(claims.holds(target, caller)).toBe(false);
    const fresh = claims.claim(target, caller);
    expect(fresh.claim_id).not.toBe(first.claim_id);
  });

  test("TEST-8 REQ-32 a same-owner claim preserves grant identity and extends it", () => {
    let now = 1_000;
    const claims = registry(() => now);
    const original = claims.claim(target, mcp);
    now += 9_999;

    expect(claims.claim(target, mcp)).toEqual(original);
    now += 9_999;
    expect(claims.holder(target)).toEqual(original);
    now += 1;

    expect(claims.holder(target)).toBeNull();
  });

  test.each([
    [mcp, viewer("a"), 10_000, false],
    [peer, otherPeer("other"), 10_000, false],
    [mcp, mcp, 10_000, true],
    [peer, peer, 10_000, true],
  ] as const)(
    "TEST-9 REQ-12 REQ-32 capture by %j on %j renews only own Claude Code claim",
    (owner, capturing, ttl, renews) => {
      let now = 1_000;
      const claims = registry(() => now);
      const grant = claims.claim(target, owner);
      now += ttl - 1;

      claims.renewFromCapture(target, capturing);
      now += 1;

      expect(claims.holder(target)).toEqual(renews ? grant : null);
      if (renews) {
        now += ttl - 1;
        expect(claims.holder(target)).toBeNull();
      }
    }
  );

  test("TEST-10 REQ-18 a peer connection's close releases exactly its own targets", () => {
    const claims = registry();
    const a = otherPeer("a");
    claims.claim(target, a);
    claims.claim("s:beta", a);
    const b = claims.claim("r:replay-a", otherPeer("b"));

    claims.releaseConnection("a");

    expect(claims.holder(target)).toBeNull();
    expect(claims.holder("s:beta")).toBeNull();
    expect(claims.holder("r:replay-a")).toEqual(b);
    claims.releaseConnection("a");
    expect(claims.holder("r:replay-a")).toEqual(b);
  });
});
