import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeychainDeps, KeychainRunResult } from "../../providers/keychain.js";

export interface SecurityFaults {
  writeExit?: number;
  writeKilled?: "before" | "after";
  readExit?: number;
  truncateStored?: boolean;
}
export interface SecurityCall {
  command: string;
  service?: string;
  account?: string;
  update?: boolean;
  trusted?: string;
  payloadInArgv?: boolean;
}
interface Disk {
  items: Record<string, string>;
  faults: SecurityFaults;
}

// These strings/codes come from spec §6.1 and the supplied keychain.test.ts.
// The measurement report is not supplied; no machine's security binary is queried.
const ABSENT =
  "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";
const LOCKED = "User interaction is not allowed";
const result = (code: number, stdout = "", stderr = ""): KeychainRunResult => ({
  code,
  stdout,
  stderr,
});

/** Parse security's quoted stdin command; never pass it to a shell. */
function words(line: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let active = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of line.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      active = true;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) tokens.push(token);
      token = "";
      active = false;
    } else {
      token += char;
      active = true;
    }
  }
  assert.equal(escaped, false, "unterminated security escape");
  assert.equal(quote, null, "unterminated security quote");
  if (active) tokens.push(token);
  return tokens;
}

/** File-backed fake shared by movers in independent Bun processes. No subprocesses. */
export class FakeSecurity {
  readonly dataPath: string;
  readonly logPath: string;
  private serial = 0;

  constructor(root: string) {
    this.dataPath = join(root, "fake-security.json");
    this.logPath = join(root, "fake-security-calls.jsonl");
    // Parent initializes before spawning peers, avoiding initialization races.
    if (!existsSync(this.dataPath)) this.save({ items: {}, faults: {} });
    if (!existsSync(this.logPath)) writeFileSync(this.logPath, "", { mode: 0o600 });
  }

  private load(): Disk {
    return JSON.parse(readFileSync(this.dataPath, "utf8")) as Disk;
  }

  private save(data: Disk): void {
    const staging = this.dataPath + "." + process.pid + "." + this.serial++;
    writeFileSync(staging, JSON.stringify(data), { mode: 0o600 });
    renameSync(staging, this.dataPath);
  }

  faults(next: SecurityFaults): void {
    const disk = this.load();
    disk.faults = next;
    this.save(disk);
  }

  calls(): SecurityCall[] {
    return readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SecurityCall);
  }

  adds(): SecurityCall[] {
    return this.calls().filter((call) => call.command === "add-generic-password");
  }

  item(account: string): string | undefined {
    return this.load().items["claudish-accounts:" + account];
  }

  itemNames(): string[] {
    return Object.keys(this.load().items);
  }

  private record(call: SecurityCall): void {
    // Never log stdin, -w, -X, or stored payloads.
    appendFileSync(this.logPath, JSON.stringify(call) + "\n");
  }

  readonly run: KeychainDeps["run"] = (args, stdin) => {
    const interactive = args.length === 1 && args[0] === "-i";
    if (interactive && (!stdin || stdin.trim().includes("\n"))) {
      this.record({ command: "UNSUPPORTED" });
      throw new Error("fake security accepts exactly one stdin command");
    }
    const argv = interactive ? words(stdin ?? "") : [...args];
    const command = argv.shift() ?? "";
    if (
      !["add-generic-password", "find-generic-password", "delete-generic-password"].includes(
        command
      ) ||
      (command === "add-generic-password" && !interactive)
    ) {
      this.record({ command: "UNSUPPORTED" });
      throw new Error("unsupported fake security command (real security is forbidden)");
    }
    const fields = new Map<string, string>();
    const flags = new Set<string>();
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "-U" || (arg === "-w" && command === "find-generic-password")) {
        flags.add(arg);
      } else if (
        ["-s", "-a", "-w", "-X", "-T", "-l", "-D", "-j"].includes(arg) &&
        argv[i + 1] !== undefined
      ) {
        fields.set(arg, argv[++i]!);
      } else {
        this.record({ command: "UNSUPPORTED" });
        throw new Error("unsupported fake security option");
      }
    }
    const service = fields.get("-s");
    const account = fields.get("-a");
    const payloadInArgv = !interactive && (fields.has("-X") || fields.has("-w"));
    this.record({
      command,
      service,
      account,
      payloadInArgv,
      ...(command === "add-generic-password"
        ? { update: flags.has("-U"), trusted: fields.get("-T") }
        : {}),
    });
    assert.equal(service, "claudish-accounts", "only the accounts service is permitted");
    assert.match(account ?? "", /^openai-codex:[a-z0-9]{12}$/);
    assert.equal(payloadInArgv, false, "material must never be carried in argv");
    const key = service + ":" + account;
    const disk = this.load();

    if (command === "find-generic-password") {
      assert.ok(flags.has("-w"), "only value reads are expected in these scenarios");
      if (disk.faults.readExit) return result(disk.faults.readExit, "", LOCKED);
      return disk.items[key] === undefined
        ? result(44, "", ABSENT)
        : result(0, disk.items[key] + "\n");
    }
    if (command === "delete-generic-password") {
      if (disk.items[key] === undefined) return result(44, "", ABSENT);
      delete disk.items[key];
      this.save(disk);
      return result(0);
    }

    assert.ok(flags.has("-U"), "writes must upsert unpublished crash debris");
    assert.equal(fields.get("-T"), "/usr/bin/security", "writes must pin the ACL");
    assert.notEqual(fields.has("-w"), fields.has("-X"), "exactly one payload encoding is required");
    if (disk.faults.writeKilled === "before") return result(-1, "", "security killed by SIGTERM");
    if (disk.faults.writeExit) return result(disk.faults.writeExit, "", LOCKED);
    const value = fields.has("-X")
      ? Buffer.from(fields.get("-X")!, "hex").toString("utf8")
      : fields.get("-w")!;
    disk.items[key] = disk.faults.truncateStored ? value.slice(0, -1) : value;
    this.save(disk);
    return disk.faults.writeKilled === "after"
      ? result(-1, "", "security killed by SIGTERM")
      : result(0);
  };

  deps(platform = "darwin"): KeychainDeps {
    return {
      platform: () => platform,
      run: this.run,
      runAsync: async (args, stdin) => this.run(args, stdin),
      spawnAsync: (args, stdin) => ({
        pid: undefined,
        done: Promise.resolve(this.run(args, stdin)),
      }),
    };
  }

  assertTranscript(): void {
    for (const call of this.calls()) {
      assert.ok(
        ["add-generic-password", "find-generic-password", "delete-generic-password"].includes(
          call.command
        ),
        "the fake rejected an unexpected security operation"
      );
      assert.equal(call.service, "claudish-accounts");
      assert.equal(call.payloadInArgv, false);
      if (call.command === "add-generic-password") {
        assert.equal(call.update, true);
        assert.equal(call.trusted, "/usr/bin/security");
      }
    }
  }
}
