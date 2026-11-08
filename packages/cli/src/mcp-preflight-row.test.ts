import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const children: ReturnType<typeof Bun.spawn>[] = [];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(import.meta.dir, ".preflight-reporting-"));
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  children.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

async function cell(reason: string, hint?: string): Promise<string> {
  // mcp-server's imports are isolated from the suite's HOME and module state.
  // Only this child's environment changes; the parent environment is untouched.
  const script = `
    const exit = process.exit.bind(process);
    globalThis.fetch = Object.assign(async () => {
      throw new Error("unexpected network request");
    }, { preconnect: () => {} });
    try {
      const { noRouteCell } = await import(${JSON.stringify(resolve(import.meta.dir, "mcp-server.js"))});
      console.log(JSON.stringify(noRouteCell(${JSON.stringify(reason)}, ${JSON.stringify(hint)})));
      exit(0);
    } catch (error) {
      console.error(error);
      exit(1);
    }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: dir,
      TMPDIR: dir,
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let code: number;
  try {
    code = await Promise.race([
      child.exited,
      new Promise<number>((done) => {
        timer = setTimeout(() => {
          child.kill();
          done(124);
        }, 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  expect({ code, stderr: await stderr }).toEqual({ code: 0, stderr: "" });
  return JSON.parse((await stdout).trim());
}

function expectSafeCell(value: string) {
  expect(value).not.toMatch(/[\r\n]/);
  // A pipe is escaped only when preceded by an odd number of backslashes.
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "|") continue;
    let backslashes = 0;
    for (let previous = index - 1; previous >= 0 && value[previous] === "\\"; previous--) {
      backslashes++;
    }
    expect(backslashes % 2).toBe(1);
  }
}

describe("F3: preflight no-route status cell", () => {
  test("Muse single-line hint is kept in full, including the route remedy", async () => {
    const reason = 'No credentials configured for "meta-muse-code".';
    const hint =
      "Log in with `claudish login muse`, or `muse login` in an interactive terminal and allow Keychain access · Use: claudish --model or@muse-spark-1.3 (route via OpenRouter)";
    const value = await cell(reason, hint);
    expect(value).toBe(`${reason} ${hint}`);
    expectSafeCell(value);
  }, 12000);

  test("non-Muse single-line hint is kept in full", async () => {
    const reason = 'No credentials configured for "openrouter".';
    const hint = "Set OPENROUTER_API_KEY and retry the request";
    const value = await cell(reason, hint);
    expect(value).toContain(reason);
    expect(value).toContain(hint);
    expectSafeCell(value);
  }, 12000);

  test("drops only the hint line that repeats the reason", async () => {
    const reason = 'No credentials configured for "meta-muse-code".';
    const remedy = "Run `claudish login muse`";
    const other = "Then retry | keep this entire remedy";
    const value = await cell(reason, `${reason}\n${remedy}\n${other}`);
    expect(value.split(reason)).toHaveLength(2);
    expect(value).toContain(remedy);
    expect(value.replace(/\\\|/g, "|")).toContain(other);
    expectSafeCell(value);
  }, 12000);

  test("multiline remedy and pipes stay within one Markdown table cell", async () => {
    const reason = 'No credentials configured for "meta-muse-code". own | borrowed';
    const hint = "Run `claudish login muse`\nOr allow Keychain access | retry the probe";
    const value = await cell(reason, hint);
    expect(value.replace(/\\\|/g, "|")).toContain(reason);
    expect(value).toContain("claudish login muse");
    expect(value).toContain("allow Keychain access");
    expect(value).toContain("retry the probe");
    expect(value.replace(/\\\|/g, "|")).toContain("access | retry");
    expectSafeCell(value);
  }, 12000);

  test("without a hint the reason is the entire cell", async () => {
    const reason = 'No credentials configured for "meta-muse-code".';
    const value = await cell(reason);
    expect(value).toBe(reason);
    expectSafeCell(value);
    expect(await cell(reason, "")).toBe(reason);
  }, 22000);

  test("a non-Muse provider retains its reason and remedy", async () => {
    const reason = 'No credentials configured for "openrouter".';
    const value = await cell(reason, "Set OPENROUTER_API_KEY\nThen retry the request | probe");
    expect(value).toContain(reason);
    expect(value).toContain("Set OPENROUTER_API_KEY");
    expect(value).toContain("Then retry the request");
    expect(value.replace(/\\\|/g, "|")).toContain("request | probe");
    expectSafeCell(value);
  }, 12000);
});
