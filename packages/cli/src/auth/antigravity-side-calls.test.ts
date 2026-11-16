import { afterEach, describe, expect, test } from "bun:test";
import { redactSigningValues } from "../redact.js";
import {
  antigravityAccountCalls,
  antigravityTrajectoryAclCall,
  sendAntigravitySideCall,
  sendAntigravitySideCalls,
} from "./antigravity-side-calls.js";

const ACCOUNT = {
  apiBase: "https://daily-cloudcode-pa.googleapis.com/v1internal",
  defaultHost: true,
  userAgent: "antigravity/cli/1.5.9 (aidev_client)",
  projectId: "project-one",
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function recordFetch(answer: () => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return answer();
  }) as typeof fetch;
  return seen;
}

describe("the account lookups of a start", () => {
  test("are the Antigravity CLI's six, in its order, with the project as the body", () => {
    const calls = antigravityAccountCalls(ACCOUNT);
    expect(calls.map((call) => call.url)).toEqual([
      "https://www.googleapis.com/oauth2/v2/userinfo",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAdminControls",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchUserInfo",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:listExperiments",
      "https://aicode.googleapis.com/v1alpha:fetchConfig",
    ]);
    expect(calls.map((call) => call.body)).toEqual([
      undefined,
      '{"project":"project-one"}',
      '{"project":"project-one"}',
      '{"project":"project-one"}',
      '{"project":"project-one"}',
      undefined,
    ]);
    expect(calls[0].userAgent).toBe("Go-http-client/1.1");
    expect(calls[5].userAgent).toBe(ACCOUNT.userAgent);
  });

  test("leave out the two other Google hosts when the host is the user's own", () => {
    const calls = antigravityAccountCalls({
      ...ACCOUNT,
      apiBase: "http://127.0.0.1:8899/v1internal",
      defaultHost: false,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8899/v1internal:fetchAdminControls",
      "http://127.0.0.1:8899/v1internal:fetchUserInfo",
      "http://127.0.0.1:8899/v1internal:retrieveUserQuotaSummary",
      "http://127.0.0.1:8899/v1internal:listExperiments",
    ]);
  });
});

test("the conversation's access write names its trajectory", () => {
  expect(antigravityTrajectoryAclCall(ACCOUNT, "trajectory-1")).toEqual({
    name: "writeTrajectoryAcls",
    url: "https://daily-cloudcode-pa.googleapis.com/v1internal:writeTrajectoryAcls",
    userAgent: ACCOUNT.userAgent,
    body: '{"trajectoryId":"trajectory-1"}',
  });
});

describe("sending a side call", () => {
  test("a POST carries the bearer, the user agent and a JSON content type", async () => {
    const seen = recordFetch(() => new Response("{}"));
    await sendAntigravitySideCall(antigravityTrajectoryAclCall(ACCOUNT, "t"), "token-1");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers).toEqual({
      Authorization: "Bearer token-1",
      "User-Agent": ACCOUNT.userAgent,
      "Content-Type": "application/json",
    });
    expect(seen[0].body).toBe('{"trajectoryId":"t"}');
  });

  test("a GET carries no body and no content type", async () => {
    const seen = recordFetch(() => new Response("{}"));
    await sendAntigravitySideCall(antigravityAccountCalls(ACCOUNT)[0], "token-1");
    expect(seen[0].method).toBe("GET");
    expect(seen[0].headers).toEqual({
      Authorization: "Bearer token-1",
      "User-Agent": "Go-http-client/1.1",
    });
    expect(seen[0].body).toBeUndefined();
  });

  test("the token is redacted from text for as long as the call runs, and no longer", async () => {
    const token = "ya29.side-call-token-0123456789abcdef";
    const quoted = `rejected Authorization: Bearer ${token}`;
    let during = "";
    recordFetch(() => {
      during = redactSigningValues(quoted);
      throw new Error(quoted);
    });
    await sendAntigravitySideCall(antigravityAccountCalls(ACCOUNT)[0], token);
    expect(during).not.toContain(token);
    expect(redactSigningValues(quoted)).toBe(quoted);
  });

  test("a refused call and a thrown one both resolve, and the calls after them are still sent", async () => {
    let count = 0;
    const seen = recordFetch(() => {
      count++;
      if (count === 1) return new Response("no", { status: 403 });
      if (count === 2) throw new Error("socket closed");
      return new Response("{}");
    });
    await sendAntigravitySideCalls(antigravityAccountCalls(ACCOUNT), "token-1");
    expect(seen).toHaveLength(6);
  });

  test("a call that gets no answer ends at its time limit", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    const started = Date.now();
    await sendAntigravitySideCall(antigravityAccountCalls(ACCOUNT)[1], "token-1", 50);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
