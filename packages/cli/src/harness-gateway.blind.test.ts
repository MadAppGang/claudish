import { describe, expect, test } from "bun:test";
import {
  applyHarnessGateway,
  harnessGatewayNotice,
  resolveHarnessGateway,
} from "./harness-gateway.js";
import type { ClaudishProfileConfig } from "./profile-config.js";

function withSetting(setting: unknown): ClaudishProfileConfig {
  // Invalid runtime config is intentional input to the validator.
  return { harnessGateway: setting } as ClaudishProfileConfig;
}

function expectInvalid(config: ClaudishProfileConfig, forbidden: string[] = []): void {
  const result = resolveHarnessGateway(config);
  expect(result.kind).toBe("invalid");
  if (result.kind !== "invalid") throw new Error("Expected an invalid gateway setting");
  expect(result.message).toContain("harnessGateway");
  for (const value of forbidden) {
    expect(result.message).not.toContain(value);
  }
}

describe("harness gateway validation", () => {
  test("REQ-1: an absent harnessGateway block is off", () => {
    expect(resolveHarnessGateway({} as ClaudishProfileConfig)).toEqual({ kind: "off" });
  });

  test("REQ-1: an object without url is off", () => {
    expect(resolveHarnessGateway(withSetting({}))).toEqual({ kind: "off" });
  });

  test("REQ-1: an explicitly undefined url is off", () => {
    expect(resolveHarnessGateway(withSetting({ url: undefined }))).toEqual({ kind: "off" });
  });

  const invalidBlocks: Array<{ label: string; value: unknown }> = [
    { label: "string", value: "http://127.0.0.1:18081" },
    { label: "array", value: ["http://127.0.0.1:18081"] },
    { label: "null", value: null },
    { label: "number", value: 18081 },
    { label: "boolean", value: false },
  ];
  for (const { label, value } of invalidBlocks) {
    test(`REQ-1: a ${label} harnessGateway block is invalid without echoing it`, () => {
      const printed = typeof value === "string" ? value : JSON.stringify(value);
      expectInvalid(withSetting(value), [printed]);
    });
  }

  const invalidUrls: Array<{ label: string; value: unknown }> = [
    { label: "number", value: 18081 },
    { label: "object", value: { address: "http://127.0.0.1:18081" } },
    { label: "array", value: ["http://127.0.0.1:18081"] },
    { label: "null", value: null },
    { label: "boolean", value: true },
  ];
  for (const { label, value } of invalidUrls) {
    test(`REQ-1: a ${label} url is invalid without echoing it`, () => {
      expectInvalid(withSetting({ url: value }), [JSON.stringify(value)]);
    });
  }

  for (const scheme of ["http", "https"]) {
    for (const host of ["127.0.0.1", "127.42.17.9", "[::1]", "localhost"]) {
      test(`REQ-1: accepts ${scheme} on ${host} and trims surrounding whitespace`, () => {
        const url = `${scheme}://${host}:18081/gateway`;
        expect(resolveHarnessGateway(withSetting({ url: ` \t${url}\n ` }))).toEqual({
          kind: "on",
          url,
        });
      });
    }
  }

  const rejectedUrls = [
    { label: "public hostname", url: "http://example.com:18081" },
    { label: "10.x LAN address", url: "http://10.0.0.1:18081" },
    { label: "192.168.x LAN address", url: "http://192.168.1.2:18081" },
    { label: "wildcard address", url: "http://0.0.0.0:18081" },
    { label: "FTP scheme", url: "ftp://127.0.0.1:18081" },
    { label: "non-URL text", url: "gateway-is-not-a-url" },
    { label: "empty text", url: "" },
    { label: "whitespace-only text", url: "   " },
  ];
  for (const { label, url } of rejectedUrls) {
    test(`REQ-1: rejects ${label} without echoing the configured value`, () => {
      expectInvalid(withSetting({ url }), url ? [url] : []);
    });
  }

  test("REQ-1: an invalid credential-bearing URL never exposes its URL or credentials", () => {
    const username = "gateway-test-user";
    const password = "gateway-test-password";
    const url = `http://${username}:${password}@example.com:18081`;
    expectInvalid(withSetting({ url }), [url, username, password]);
  });
});

function targetLines(env: Record<string, string>): string[] {
  return env.ANTHROPIC_CUSTOM_HEADERS.split("\n").filter((line) => /^x-target-url:/i.test(line));
}

describe("harness gateway child environment", () => {
  const gatewayUrl = "http://127.0.0.1:18081";
  const proxyUrl = "http://127.0.0.1:19191";

  test("REQ-2: mutates the supplied environment and creates a single target header", () => {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:19999",
      KEEP: "unchanged",
    };

    applyHarnessGateway(env, gatewayUrl, proxyUrl);

    expect(env).toEqual({
      ANTHROPIC_BASE_URL: gatewayUrl,
      ANTHROPIC_CUSTOM_HEADERS: `X-Target-URL: ${proxyUrl}`,
      KEEP: "unchanged",
    });
  });

  test("REQ-2: keeps all other header lines in order and drops empty lines", () => {
    const preserved = [
      "X-First: first",
      "X-Note: keep  two spaces ",
      "X-Target-URL-Extra: not-the-target",
      "X-First: repeated",
    ];
    const env: Record<string, string> = {
      ANTHROPIC_CUSTOM_HEADERS: `\n${preserved[0]}\n\n${preserved[1]}\n${preserved[2]}\n\n${preserved[3]}\n`,
    };

    applyHarnessGateway(env, gatewayUrl, proxyUrl);

    const lines = env.ANTHROPIC_CUSTOM_HEADERS.split("\n");
    expect(env.ANTHROPIC_BASE_URL).toBe(gatewayUrl);
    expect(targetLines(env)).toEqual([`X-Target-URL: ${proxyUrl}`]);
    expect(lines.filter((line) => !/^x-target-url:/i.test(line))).toEqual(preserved);
    expect(lines).not.toContain("");
  });

  for (const header of ["X-Target-URL", "x-target-url", "X-TARGET-URL", "x-TaRgEt-UrL"]) {
    test(`REQ-2: replaces an existing ${header} header`, () => {
      const env: Record<string, string> = {
        ANTHROPIC_CUSTOM_HEADERS: `X-Before: a\n${header}: http://127.0.0.1:19999\nX-After: b`,
      };

      applyHarnessGateway(env, gatewayUrl, proxyUrl);

      expect(targetLines(env)).toEqual([`X-Target-URL: ${proxyUrl}`]);
      expect(
        env.ANTHROPIC_CUSTOM_HEADERS.split("\n").filter((line) => !/^x-target-url:/i.test(line))
      ).toEqual(["X-Before: a", "X-After: b"]);
      expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain("19999");
    });
  }

  test("REQ-2: collapses duplicate target headers and replaces the target on a second application", () => {
    const env: Record<string, string> = {
      ANTHROPIC_CUSTOM_HEADERS:
        "x-target-url: old-a\nX-Keep: yes\nX-TARGET-URL: old-b\n\nX-Target-URL: old-c",
    };

    applyHarnessGateway(env, gatewayUrl, proxyUrl);
    expect(targetLines(env)).toEqual([`X-Target-URL: ${proxyUrl}`]);
    expect(
      env.ANTHROPIC_CUSTOM_HEADERS.split("\n").filter((line) => !/^x-target-url:/i.test(line))
    ).toEqual(["X-Keep: yes"]);

    const nextProxyUrl = "http://127.0.0.1:19192";
    applyHarnessGateway(env, gatewayUrl, nextProxyUrl);
    expect(targetLines(env)).toEqual([`X-Target-URL: ${nextProxyUrl}`]);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain(proxyUrl);
    expect(
      env.ANTHROPIC_CUSTOM_HEADERS.split("\n").filter((line) => !/^x-target-url:/i.test(line))
    ).toEqual(["X-Keep: yes"]);
  });

  test("REQ-2: an empty custom-header value becomes only the target header", () => {
    const env: Record<string, string> = { ANTHROPIC_CUSTOM_HEADERS: "\n\n" };
    applyHarnessGateway(env, gatewayUrl, proxyUrl);
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(`X-Target-URL: ${proxyUrl}`);
  });
});

describe("harness gateway notice", () => {
  for (const nativeRoute of [true, false]) {
    for (const address of ["http://127.0.0.1:18081/gateway", "https://[::1]:18081/gateway"]) {
      test(`REQ-3: ${nativeRoute ? "native" : "foreign"} notice redacts credentials at ${address}`, () => {
        const username = "gateway-test-user";
        const password = "gateway-test-password";
        const url = address.replace("://", `://${username}:${password}@`);

        const notice = harnessGatewayNotice(url, nativeRoute);

        // The notice shows the origin only: a path, query or fragment can carry a credential.
        expect(notice).toContain(new URL(address).origin);
        expect(notice).not.toContain("/gateway");
        expect(notice).not.toContain(username);
        expect(notice).not.toContain(password);
        expect(notice).not.toContain(url);
        expect(notice).not.toMatch(/[\r\n]/);
        if (nativeRoute) expect(notice).toMatch(/\btoken\b/i);
        else expect(notice).not.toMatch(/\btoken\b/i);
      });
    }
  }
});
