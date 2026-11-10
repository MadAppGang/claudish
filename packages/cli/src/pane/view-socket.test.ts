import { describe, expect, test } from "bun:test";
import type { MagmuxClient, MagmuxReply } from "./magmux-client.js";
import { viewSockPathOf } from "./process-identity.js";
import { verifyViewSocket } from "./view-socket.js";

const ROOT = "/r";
const ID = "p-abc123";
const VIEW = viewSockPathOf(ROOT, ID);

/** A dial that answers one `capabilities` reply and records what it was asked. */
function dialAnswering(reply: MagmuxReply) {
  const seen = { dialed: [] as string[], closed: 0 };
  const dial = async (path: string): Promise<MagmuxClient> => {
    seen.dialed.push(path);
    return {
      request: async () => reply,
      close: () => {
        seen.closed++;
      },
    } as unknown as MagmuxClient;
  };
  return { dial, seen };
}

describe("verifyViewSocket", () => {
  test("a control socket that reports no view socket is unverified, and nothing is dialed", async () => {
    const { dial, seen } = dialAnswering({ ok: true, result: { readOnly: true } });
    expect(await verifyViewSocket({}, ROOT, ID, dial)).toMatchObject({ ok: false });
    expect(await verifyViewSocket(null, ROOT, ID, dial)).toMatchObject({ ok: false });
    expect(seen.dialed).toEqual([]);
  });

  test("a view socket path other than the derived one is unverified, and nothing is dialed", async () => {
    const { dial, seen } = dialAnswering({ ok: true, result: { readOnly: true } });
    const check = await verifyViewSocket({ viewSocket: "/elsewhere/x.view" }, ROOT, ID, dial);
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.detail).toContain("/elsewhere/x.view");
    expect(seen.dialed).toEqual([]);
  });

  test("a view socket that does not answer readOnly:true is unverified", async () => {
    for (const result of [{}, { readOnly: false }, { readOnly: "true" }]) {
      const { dial, seen } = dialAnswering({ ok: true, result });
      expect(await verifyViewSocket({ viewSocket: VIEW }, ROOT, ID, dial)).toMatchObject({
        ok: false,
      });
      expect(seen.closed).toBe(1);
    }
  });

  test("a refused capabilities request or a failed dial is unverified", async () => {
    const refused = dialAnswering({ ok: false, code: "client_timeout", error: "no reply" });
    expect(await verifyViewSocket({ viewSocket: VIEW }, ROOT, ID, refused.dial)).toEqual({
      ok: false,
      detail: "client_timeout: no reply",
    });
    const failing = async (): Promise<MagmuxClient> => {
      throw new Error("ECONNREFUSED");
    };
    expect(await verifyViewSocket({ viewSocket: VIEW }, ROOT, ID, failing)).toEqual({
      ok: false,
      detail: "ECONNREFUSED",
    });
  });

  test("the derived path answering readOnly:true is verified", async () => {
    const { dial, seen } = dialAnswering({ ok: true, result: { readOnly: true } });
    expect(await verifyViewSocket({ viewSocket: VIEW }, ROOT, ID, dial)).toEqual({
      ok: true,
      path: VIEW,
    });
    expect(seen).toEqual({ dialed: [VIEW], closed: 1 });
  });
});
