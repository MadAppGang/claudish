// REGRESSION: team voters in a ps-less sandbox lose their launch dir; proxied pane child hits the API-key dialog — Fixed in /dev:fix session dev-fix-20261021-011007-a7c3

import { describe, expect, test } from "bun:test";
import {
  CLAUDISH_PLACEHOLDER_API_KEY,
  CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
  applyProxyPlaceholderAuth,
} from "./claude-runner.js";

const initialAuth: Array<{ name: string; values: Record<string, string | undefined> }> = [
  { name: "absent credentials", values: {} },
  {
    name: "explicitly undefined credentials",
    values: { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined },
  },
  {
    name: "placeholder credentials",
    values: {
      ANTHROPIC_API_KEY: CLAUDISH_PLACEHOLDER_API_KEY,
      ANTHROPIC_AUTH_TOKEN: CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
    },
  },
  {
    name: "preexisting credentials",
    values: {
      ANTHROPIC_API_KEY: "sk-ant-api03-" + "a".repeat(40),
      ANTHROPIC_AUTH_TOKEN: "previous-auth-token",
    },
  },
];

describe("applyProxyPlaceholderAuth", () => {
  for (const { name, values } of initialAuth) {
    test(`B1: a pane child deletes ANTHROPIC_API_KEY with ${name}`, () => {
      const env = { ...values };
      const result = applyProxyPlaceholderAuth(env, true);
      expect(result).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(CLAUDISH_PLACEHOLDER_AUTH_TOKEN);
      expect("ANTHROPIC_API_KEY" in env).toBe(false);
      expect(env).toEqual({ ANTHROPIC_AUTH_TOKEN: CLAUDISH_PLACEHOLDER_AUTH_TOKEN });
    });

    test(`B2: outside a pane both placeholders replace ${name}`, () => {
      const env = { ...values };
      const result = applyProxyPlaceholderAuth(env, false);
      expect(result).toBeUndefined();
      expect(env).toEqual({
        ANTHROPIC_API_KEY: CLAUDISH_PLACEHOLDER_API_KEY,
        ANTHROPIC_AUTH_TOKEN: CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
      });
    });
  }

  test.each([true, false])("B3: other keys are unchanged (paneChild=%p)", (paneChild) => {
    const unrelated = {
      PATH: "/test/bin",
      HOME: "/test/home",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:12345",
      CLAUDISH_PANE_CHILD: "keep-this-value",
      CLAUDISH_PANE_CWD: "/test/workspace",
      EMPTY: "",
      OPTIONAL: undefined,
    };
    const env: Record<string, string | undefined> = {
      ...unrelated,
      ANTHROPIC_API_KEY: "previous-key",
      ANTHROPIC_AUTH_TOKEN: "previous-auth-token",
    };
    applyProxyPlaceholderAuth(env, paneChild);
    expect(env).toEqual({
      ...unrelated,
      ANTHROPIC_AUTH_TOKEN: CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
      ...(paneChild ? {} : { ANTHROPIC_API_KEY: CLAUDISH_PLACEHOLDER_API_KEY }),
    });
  });

  test("B4: omitted paneChild follows the current process pane flag and cwd", () => {
    const savedFlag = process.env.CLAUDISH_PANE_CHILD;
    const savedCwd = process.env.CLAUDISH_PANE_CWD;
    try {
      process.env.CLAUDISH_PANE_CHILD = "1";
      process.env.CLAUDISH_PANE_CWD = import.meta.dir;
      const paneEnv: Record<string, string | undefined> = {
        ANTHROPIC_API_KEY: "previous-key",
        ANTHROPIC_AUTH_TOKEN: "previous-auth-token",
        UNRELATED: "preserved",
      };
      applyProxyPlaceholderAuth(paneEnv);
      expect("ANTHROPIC_API_KEY" in paneEnv).toBe(false);
      expect(paneEnv).toEqual({
        ANTHROPIC_AUTH_TOKEN: CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
        UNRELATED: "preserved",
      });

      delete process.env.CLAUDISH_PANE_CHILD;
      delete process.env.CLAUDISH_PANE_CWD;
      const outsideEnv: Record<string, string | undefined> = {
        ANTHROPIC_API_KEY: "previous-key",
        ANTHROPIC_AUTH_TOKEN: "previous-auth-token",
        UNRELATED: "preserved",
      };
      applyProxyPlaceholderAuth(outsideEnv);
      expect(outsideEnv).toEqual({
        ANTHROPIC_API_KEY: CLAUDISH_PLACEHOLDER_API_KEY,
        ANTHROPIC_AUTH_TOKEN: CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
        UNRELATED: "preserved",
      });
    } finally {
      if (savedFlag === undefined) delete process.env.CLAUDISH_PANE_CHILD;
      else process.env.CLAUDISH_PANE_CHILD = savedFlag;
      if (savedCwd === undefined) delete process.env.CLAUDISH_PANE_CWD;
      else process.env.CLAUDISH_PANE_CWD = savedCwd;
    }
  });
});
