import { describe, expect, test } from "bun:test";
import { harnessGatewayNotice } from "./harness-gateway.js";

const secret = "notice-test-private-value";

describe("harnessGatewayNotice shows the gateway origin only", () => {
  for (const [where, url] of [
    ["query", `http://127.0.0.1:18081/gw?access_token=${secret}`],
    ["fragment", `http://127.0.0.1:18081/gw#${secret}`],
    ["path", `http://127.0.0.1:18081/${secret}/v1`],
    ["userinfo", `http://user:${secret}@127.0.0.1:18081/`],
  ] as const) {
    test(`a value in the ${where} never reaches the notice`, () => {
      for (const native of [false, true]) {
        const notice = harnessGatewayNotice(url, native);
        expect(notice).not.toContain(secret);
        expect(notice).toContain("http://127.0.0.1:18081");
      }
    });
  }

  test("an unparseable value is never echoed", () => {
    const notice = harnessGatewayNotice(`not a url ${secret}`, false);
    expect(notice).not.toContain(secret);
  });
});
