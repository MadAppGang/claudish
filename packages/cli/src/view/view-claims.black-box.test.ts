import { afterEach, describe, expect, test } from "bun:test";
import { type ClaimCaller, ViewClaims } from "./view-claims.js";

const target = "s:alpha";
const mcp: ClaimCaller = { kind: "mcp" };
const peer: ClaimCaller = { kind: "conn", role: "peer", connId: "peer" };
const viewer = (id: string, frontEnd = "herdr"): ClaimCaller => ({
  kind: "conn",
  role: "viewer",
  connId: id,
  frontEnd,
});
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
    [viewer("h"), "herdr", "herdr"],
    [viewer("app", "herdr-core"), "herdr_app", "herdr_app"],
    [viewer("term", "none"), "terminal", "terminal"],
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

  test("TEST-7 REQ-11 REQ-12 latest act wins; old owner cannot release new claim or another target", () => {
    let now = 1_000;
    const claims = registry(() => now);
    const a = viewer("a");
    const b = viewer("b");
    const first = claims.claim(target, a);
    const independent = claims.claim("s:beta", a);
    now += 1;

    const second = claims.claim(target, b);

    expect(second.claim_id).not.toBe(first.claim_id);
    expect(second.since).not.toBe(first.since);
    expect(claims.holds(target, a)).toBe(false);
    expect(claims.release(target, a)).toEqual(second);
    expect(claims.holder("s:beta")).toEqual(independent);
    expect(claims.release(target, b)).toBeNull();
    expect(claims.holder(target)).toBeNull();
  });

  test.each([
    [viewer("v"), 15_000],
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

  test("TEST-8 REQ-32 viewer heartbeat and same-owner claim preserve grant identity", () => {
    let now = 1_000;
    const claims = registry(() => now);
    const a = viewer("a");
    const original = claims.claim(target, a);
    now += 14_999;

    expect(claims.renew(target, a)).toEqual(original);
    now += 14_999;
    expect(claims.holder(target)).toEqual(original);
    expect(claims.claim(target, a)).toEqual(original);
    now += 15_000;

    expect(claims.holder(target)).toBeNull();
    expect(() => claims.renew(target, a)).toThrow();
  });

  test.each([
    [viewer("a"), viewer("a"), 15_000, false],
    [mcp, viewer("a"), 10_000, false],
    [peer, { kind: "conn", role: "peer", connId: "other" } as ClaimCaller, 10_000, false],
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

  test("TEST-10 REQ-18 connection close releases exactly its own targets", () => {
    const claims = registry();
    const a = viewer("a");
    claims.claim(target, a);
    claims.claim("s:beta", a);
    const b = claims.claim("r:replay-a", viewer("b"));

    claims.releaseConnection("a");

    expect(claims.holder(target)).toBeNull();
    expect(claims.holder("s:beta")).toBeNull();
    expect(claims.holder("r:replay-a")).toEqual(b);
    claims.releaseConnection("a");
    expect(claims.holder("r:replay-a")).toEqual(b);
  });

  test("TEST-11 REQ-28 REQ-33 terminal labels strip unsafe characters and stay bounded", () => {
    const claims = registry();
    const grant = claims.claim(target, {
      kind: "conn",
      connId: "a",
      role: "viewer",
      frontEnd: "none",
      termProgram: "\u001b]0;unsafe\u0007\n" + "T".repeat(200),
    });

    expect(grant.holder).toBe("terminal");
    expect(grant.label).toMatch(/^[A-Za-z0-9 ._-]+$/);
    expect(grant.label.length).toBeLessThanOrEqual(24);
    expect(grant.label.length).toBeGreaterThan(0);
  });

  test("TEST-11 REQ-28 unknown front end cannot replace existing holder", () => {
    const claims = registry();
    const existing = claims.claim(target, mcp);

    expect(() => claims.claim(target, viewer("a", "not-a-front-end"))).toThrow();
    expect(claims.holder(target)).toEqual(existing);
  });
});
