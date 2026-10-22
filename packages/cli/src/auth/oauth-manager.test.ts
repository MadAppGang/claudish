import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type BaseCredentials, OAuthManager } from "./oauth-manager.js";

const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
const originalExitDescriptor = Object.getOwnPropertyDescriptor(process, "exit");
const originalConsoleLog = console.log;

class FakeStdin extends EventEmitter {
  readonly rawModeCalls: boolean[] = [];
  resumeCalls = 0;
  pauseCalls = 0;

  constructor(readonly isTTY: boolean) {
    super();
  }

  setRawMode(enabled: boolean): this {
    this.rawModeCalls.push(enabled);
    return this;
  }

  resume(): this {
    this.resumeCalls += 1;
    return this;
  }

  pause(): this {
    this.pauseCalls += 1;
    return this;
  }
}

class TestOAuthManager extends OAuthManager<BaseCredentials> {
  protected readonly credentialFile = "unused-test-credential.json";
  protected readonly providerName = "TestOAuth";
  protected readonly loginHint = "unused";
  readonly clipboardCalls: string[] = [];

  protected async doRefreshToken(current: BaseCredentials): Promise<BaseCredentials> {
    return current;
  }

  protected validateCredentials(_data: unknown): _data is BaseCredentials {
    return false;
  }

  protected override async copyToClipboard(text: string): Promise<boolean> {
    this.clipboardCalls.push(text);
    return true;
  }

  present(url: string): () => void {
    return this.presentAuthUrl(url);
  }
}

afterEach(() => {
  if (originalStdinDescriptor) Object.defineProperty(process, "stdin", originalStdinDescriptor);
  if (originalExitDescriptor) Object.defineProperty(process, "exit", originalExitDescriptor);
  console.log = originalConsoleLog;
});

function installStdin(stdin: FakeStdin): void {
  Object.defineProperty(process, "stdin", {
    value: stdin,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

describe("OAuthManager.presentAuthUrl", () => {
  test("prints a plain URL and leaves piped stdin untouched", () => {
    const stdin = new FakeStdin(false);
    installStdin(stdin);
    const lines: string[] = [];
    console.log = ((...args: unknown[]) => lines.push(args.join(" "))) as typeof console.log;
    const manager = new TestOAuthManager();

    const dispose = manager.present("https://auth.fixture.invalid/device");

    expect(lines).toEqual(["  URL:  https://auth.fixture.invalid/device\n"]);
    // MCP hosts, team fan-out and CI provide a pipe, so raw mode must never be attempted.
    expect(stdin.rawModeCalls).toEqual([]);
    expect(stdin.resumeCalls).toBe(0);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });

  test("returns an idempotent disposer that restores TTY raw mode", () => {
    const stdin = new FakeStdin(true);
    installStdin(stdin);
    const manager = new TestOAuthManager();

    const dispose = manager.present("https://auth.fixture.invalid/device");

    expect(stdin.rawModeCalls).toEqual([true]);
    expect(stdin.resumeCalls).toBe(1);
    expect(stdin.listenerCount("data")).toBe(1);
    dispose();
    dispose();
    // A finally block may dispose twice, but terminal echo must be restored exactly once.
    expect(stdin.rawModeCalls).toEqual([true, false]);
    expect(stdin.pauseCalls).toBe(1);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  test("the c key attempts to copy through the clipboard seam", async () => {
    const stdin = new FakeStdin(true);
    installStdin(stdin);
    const manager = new TestOAuthManager();
    const url = "https://auth.fixture.invalid/device";

    const dispose = manager.present(url);
    stdin.emit("data", Buffer.from("c"));
    await Promise.resolve();
    dispose();

    // The overridden seam proves the key path without invoking pbcopy or another real tool.
    expect(manager.clipboardCalls).toEqual([url]);
  });

  test("Ctrl-C restores the terminal before requesting process exit", () => {
    const stdin = new FakeStdin(true);
    installStdin(stdin);
    const exitCodes: Array<number | undefined> = [];
    Object.defineProperty(process, "exit", {
      value: ((code?: number) => {
        exitCodes.push(code);
        return undefined as never;
      }) as typeof process.exit,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    const manager = new TestOAuthManager();

    const dispose = manager.present("https://auth.fixture.invalid/device");
    stdin.emit("data", Buffer.from([0x03]));
    dispose();

    // Raw mode suppresses normal SIGINT translation, so cleanup must precede the explicit exit.
    expect(stdin.rawModeCalls).toEqual([true, false]);
    expect(stdin.pauseCalls).toBe(1);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(exitCodes).toEqual([130]);
  });
});
