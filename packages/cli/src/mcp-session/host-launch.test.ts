/**
 * The host-launch reader: another process's exact argv and cwd. The live cases read only the
 * test's own process and a child it spawns; the parsers run on hand-built buffers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  argvOfCmdline,
  argvOfProcargs,
  cwdOfVnodePathInfo,
  hostEnvOfEnviron,
  hostEnvOfProcargs,
  readHostLaunch,
} from "./host-launch.js";

const live = process.platform === "darwin" || process.platform === "linux";

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "claudish-host-launch-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A `KERN_PROCARGS2` buffer as the kernel lays it out (measured on this Mac): `argc`, the exec
 * path NUL-padded to a multiple of 8 bytes (`extra` more NULs on top), then each string NUL-ended.
 */
function procargs(argc: number, exec: string, strings: string[], extra = 0): Buffer {
  const head = Buffer.alloc(4);
  head.writeInt32LE(argc, 0);
  const padded = Math.ceil((Buffer.byteLength(exec) + 1) / 8) * 8;
  const path = Buffer.alloc(padded + extra);
  path.write(exec);
  const rest = Buffer.from(strings.map((s) => `${s}\0`).join(""));
  return Buffer.concat([head, path, rest]);
}

/** A `proc_vnodepathinfo` buffer: 152 bytes of `vnode_info`, then `path` bytes in a 1024 field, twice. */
function vnodePathInfo(path: Buffer): Buffer {
  const buf = Buffer.alloc(2 * (152 + 1024));
  path.copy(buf, 152);
  // the second struct (root dir) begins right after the first path field
  buf.write("/", 152 + 1024 + 152);
  buf.fill(0x41, 152 + 1024, 152 + 1024 + 152);
  return buf;
}

describe("readHostLaunch, live", () => {
  test.skipIf(!live)("reads the test's own argv and cwd exactly", () => {
    const launch = readHostLaunch(process.pid);
    expect(launch).not.toBeNull();
    // `bun test` rewrites process.argv, so the kernel's view is the reference: `ps` joins the
    // arguments with spaces, which is exact while no argument holds one
    const ps = Bun.spawnSync(["ps", "-o", "args=", "-p", String(process.pid)]);
    const shown = ps.stdout.toString().trim();
    expect(launch?.argv.some((arg) => arg.includes(" "))).toBe(false);
    expect(launch?.argv.join(" ")).toBe(shown);
    expect(launch?.argv.length).toBeGreaterThan(1);
    expect(launch?.cwd).toBe(realpathSync(process.cwd()));
  });

  test.skipIf(!live)(
    "reads a spawned child's argv with spaces, quotes, an empty argument and non-ASCII text as one token each",
    async () => {
      const cwd = join(tmp, "dir with space ü");
      mkdirSync(cwd);
      const args = ["-c", "sleep 30; :", "a b", "", '--settings={"x": 1}', "ü 日本", "line\nbreak"];
      const child = Bun.spawn(["/bin/sh", ...args], { cwd });
      try {
        await Bun.sleep(100);
        const launch = readHostLaunch(child.pid);
        expect(launch?.argv).toEqual(["/bin/sh", ...args]);
        expect(launch?.cwd).toBe(cwd);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  );

  /**
   * A child that is not a platform binary: macOS leaves a platform binary's environment out of
   * `KERN_PROCARGS2` (`ps -E` shows none for `/bin/sleep`), and the reader answers that as
   * unreadable. Claude Code is not a platform binary; this Bun stands in for it.
   */
  async function withBunChild(env: Record<string, string>, read: (pid: number) => void) {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { cwd: tmp, env });
    try {
      await Bun.sleep(150);
      read(child.pid);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }

  test.skipIf(!live)(
    "reads only CLAUDE_CONFIG_DIR from a live child's launch environment",
    async () => {
      const env = {
        PATH: "/usr/bin:/bin",
        CLAUDE_CONFIG_DIR: "/cfg dir ü",
        SECRET_TOKEN: "s3cr3t",
      };
      await withBunChild(env, (pid) => {
        expect(readHostLaunch(pid)?.env).toEqual({ CLAUDE_CONFIG_DIR: "/cfg dir ü" });
      });
    }
  );

  test.skipIf(!live)(
    "reads a launch environment without CLAUDE_CONFIG_DIR as one that does not set it",
    async () => {
      await withBunChild({ PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIRX: "/not-it" }, (pid) => {
        expect(readHostLaunch(pid)?.env).toEqual({});
      });
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "answers a platform binary's environment, which macOS leaves out, as unreadable",
    async () => {
      const child = Bun.spawn(["/bin/sleep", "30"], {
        env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: "/c" },
      });
      try {
        await Bun.sleep(150);
        const launch = readHostLaunch(child.pid);
        expect(launch?.argv).toEqual(["/bin/sleep", "30"]);
        expect(launch?.env).toBeNull();
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  );

  test.skipIf(process.platform !== "darwin")(
    "is null for a live process whose argv[0] is empty",
    async () => {
      const child = Bun.spawn(["/usr/bin/perl", "-e", 'exec {"/bin/sleep"} "", "30"']);
      try {
        await Bun.sleep(150);
        expect(readHostLaunch(child.pid)).toBeNull();
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  );

  test.skipIf(!live)("is null for a process that is gone", async () => {
    const child = Bun.spawn(["/bin/sh", "-c", "exit 0"]);
    await child.exited;
    expect(readHostLaunch(child.pid)).toBeNull();
  });

  test("is null for pid 0, a negative pid, a fraction, and a pid outside the signed 32-bit range", () => {
    for (const pid of [0, 1, -1, -process.pid, 1.5, Number.NaN, 2 ** 31, 2 ** 32 + process.pid]) {
      expect(readHostLaunch(pid)).toBeNull();
    }
  });
});

describe("argvOfProcargs", () => {
  test("reads argc arguments after the exec path and its padding", () => {
    expect(argvOfProcargs(procargs(3, "/bin/sh", ["sh", "a b", "", "ENV=1"]))).toEqual([
      "sh",
      "a b",
      "",
    ]);
  });

  test("is null for a buffer too short for argc, or argc of 0 or less", () => {
    expect(argvOfProcargs(Buffer.alloc(2))).toBeNull();
    expect(argvOfProcargs(procargs(0, "/bin/sh", ["sh"]))).toBeNull();
    expect(argvOfProcargs(procargs(-2, "/bin/sh", ["sh"]))).toBeNull();
  });

  test("is null when argc is larger than the strings present", () => {
    expect(argvOfProcargs(procargs(4, "/bin/sh", ["sh", "a"]))).toBeNull();
  });

  test("is null for a truncated buffer whose last argument has no NUL end", () => {
    const full = procargs(2, "/bin/sh", ["sh", "abc"]);
    expect(argvOfProcargs(full.subarray(0, full.length - 1))).toBeNull();
  });

  test("reads an exec path of every length to its aligned end, padding of zero to seven NULs included", () => {
    for (let n = 1; n <= 17; n++) {
      const exec = `/${"x".repeat(n - 1)}`;
      expect(argvOfProcargs(procargs(2, exec, ["claude", "--x", "ENV=1"]))).toEqual([
        "claude",
        "--x",
      ]);
    }
  });

  test("is null for an empty argv[0], which a NUL scan would take for padding and shift the list into the environment", () => {
    // `exec {"/bin/sleep"} "", "30"`: argv[0] is "", its NUL right at the aligned start
    for (const exec of ["/bin/sh", "/bin/sleep", "/a"]) {
      expect(argvOfProcargs(procargs(2, exec, ["", "--settings", "ENV=1"]))).toBeNull();
    }
  });

  test("is null when more NULs follow the exec path than its alignment pads with", () => {
    expect(argvOfProcargs(procargs(1, "/bin/sleep", ["claude"], 8))).toBeNull();
  });

  test("is null when argv[0] starts before the exec path's aligned end", () => {
    const head = Buffer.alloc(4);
    head.writeInt32LE(1, 0);
    // "/bin/sleep" ends at byte 14; aligned, argv[0] starts at byte 20, not 15
    const buf = Buffer.concat([head, Buffer.from("/bin/sleep\0claude\0ENV=1\0")]);
    expect(argvOfProcargs(buf)).toBeNull();
  });

  test("is null for a buffer that ends inside the exec path", () => {
    const head = Buffer.alloc(4);
    head.writeInt32LE(1, 0);
    expect(argvOfProcargs(Buffer.concat([head, Buffer.from("/bin/s")]))).toBeNull();
  });
});

describe("cwdOfVnodePathInfo", () => {
  test("reads the NUL-ended path in the first path field", () => {
    expect(cwdOfVnodePathInfo(vnodePathInfo(Buffer.from("/Users/u/dir with space\0")))).toBe(
      "/Users/u/dir with space"
    );
    const longest = `/${"p".repeat(1022)}`;
    expect(cwdOfVnodePathInfo(vnodePathInfo(Buffer.from(`${longest}\0`)))).toBe(longest);
  });

  test("is null for a path field with no NUL inside it, even when the next struct begins with one", () => {
    const full = vnodePathInfo(Buffer.from("/".repeat(1024)));
    // the byte after the field is the second struct's first byte
    full[152 + 1024] = 0;
    expect(cwdOfVnodePathInfo(full)).toBeNull();
  });

  test("is null for an empty path, and for a buffer of another size", () => {
    expect(cwdOfVnodePathInfo(vnodePathInfo(Buffer.alloc(0)))).toBeNull();
    expect(cwdOfVnodePathInfo(Buffer.alloc(2351))).toBeNull();
  });
});

describe("argvOfCmdline", () => {
  test("splits a NUL-ended /proc cmdline into its arguments", () => {
    expect(argvOfCmdline(Buffer.from("claude\0--settings\0/a b.json\0\0"))).toEqual([
      "claude",
      "--settings",
      "/a b.json",
      "",
    ]);
    expect(argvOfCmdline(Buffer.from("claude\0"))).toEqual(["claude"]);
  });

  test("is null for an empty buffer or one with no NUL end", () => {
    expect(argvOfCmdline(Buffer.alloc(0))).toBeNull();
    expect(argvOfCmdline(Buffer.from("claude --resume x"))).toBeNull();
  });

  test("is null for a rewritten process title: every argument after argv[0] empty", () => {
    // libuv overwrites the argv area with the title and fills the rest with NULs
    expect(argvOfCmdline(Buffer.from(`claude${"\0".repeat(40)}`))).toBeNull();
    expect(argvOfCmdline(Buffer.from("claude\0\0"))).toBeNull();
  });
});

describe("hostEnvOfProcargs", () => {
  /** argv `claude --x`, then `env`, then the NUL padding and the apple strings the kernel adds. */
  const withEnv = (env: string[], tail = ["", "", "executable_path=/c", "ptr_munge="]) =>
    procargs(2, "/usr/local/bin/claude", ["claude", "--x", ...env, ...tail]);

  test("reads only CLAUDE_CONFIG_DIR from the environment after argv", () => {
    const buf = withEnv(["HOME=/h", "ANTHROPIC_API_KEY=sk-secret", "CLAUDE_CONFIG_DIR=/c d=e"]);
    expect(hostEnvOfProcargs(buf)).toEqual({ CLAUDE_CONFIG_DIR: "/c d=e" });
  });

  test("reads every launch mode switch and plugin variable, and no other key", () => {
    const buf = withEnv([
      "HOME=/h",
      "ANTHROPIC_API_KEY=sk-secret",
      "CLAUDE_CODE_RESTRICTED=1",
      "CLAUDE_CODE_SAFE_MODE=true",
      "CLAUDE_CODE_PLUGIN_DIRS=/p",
      "CLAUDE_CODE_RESTRICTEDX=1",
      "CLAUDE_CONFIG_DIR=/c",
    ]);
    expect(hostEnvOfProcargs(buf)).toEqual({
      CLAUDE_CONFIG_DIR: "/c",
      CLAUDE_CODE_RESTRICTED: "1",
      CLAUDE_CODE_SAFE_MODE: "true",
      CLAUDE_CODE_PLUGIN_DIRS: "/p",
    });
  });

  test("is null when a mode switch's value is not valid UTF-8", () => {
    const head = procargs(1, "/c", ["claude"]);
    const bad = Buffer.concat([
      head,
      Buffer.from("CLAUDE_CODE_RESTRICTED=1"),
      Buffer.from([0xff, 0]),
      Buffer.from("\0"),
    ]);
    expect(hostEnvOfProcargs(bad)).toBeNull();
  });

  test("an environment without the key sets nothing; the first of two copies wins, as getenv reads", () => {
    expect(hostEnvOfProcargs(withEnv(["HOME=/h", "XCLAUDE_CONFIG_DIR=/x"]))).toEqual({});
    expect(hostEnvOfProcargs(withEnv([]))).toEqual({});
    const twice = withEnv(["CLAUDE_CONFIG_DIR=/first", "CLAUDE_CONFIG_DIR=/second"]);
    expect(hostEnvOfProcargs(twice)).toEqual({ CLAUDE_CONFIG_DIR: "/first" });
  });

  test("never reads an apple string after the environment's end as an environment entry", () => {
    const buf = withEnv(["HOME=/h"], ["", "CLAUDE_CONFIG_DIR=/apple"]);
    expect(hostEnvOfProcargs(buf)).toEqual({});
  });

  test("is null for a buffer whose environment has no end, or whose argv cannot be read", () => {
    const cut = procargs(2, "/usr/local/bin/claude", ["claude", "--x", "HOME=/h"]);
    expect(hostEnvOfProcargs(cut)).toBeNull();
    expect(hostEnvOfProcargs(procargs(3, "/c", ["claude", "--x"]))).toBeNull();
  });

  test("is null for a value that is not valid UTF-8", () => {
    const head = procargs(1, "/c", ["claude"]);
    const bad = Buffer.concat([
      head,
      Buffer.from("CLAUDE_CONFIG_DIR=/a"),
      Buffer.from([0xff, 0]),
      Buffer.from("\0"),
    ]);
    expect(hostEnvOfProcargs(bad)).toBeNull();
  });
});

describe("hostEnvOfEnviron", () => {
  test("reads only CLAUDE_CONFIG_DIR from a NUL-separated /proc environ", () => {
    const buf = Buffer.from("HOME=/h\0ANTHROPIC_API_KEY=sk\0CLAUDE_CONFIG_DIR=/c\0");
    expect(hostEnvOfEnviron(buf)).toEqual({ CLAUDE_CONFIG_DIR: "/c" });
    expect(hostEnvOfEnviron(Buffer.from("HOME=/h\0"))).toEqual({});
  });

  test("reads the launch mode switches from a /proc environ, the first copy winning", () => {
    const buf = Buffer.from(
      "CLAUDE_CODE_SIMPLE=1\0ANTHROPIC_API_KEY=sk\0CLAUDE_CODE_SIMPLE=0\0CLAUDE_CODE_SAFE_MODE=1\0"
    );
    expect(hostEnvOfEnviron(buf)).toEqual({ CLAUDE_CODE_SIMPLE: "1", CLAUDE_CODE_SAFE_MODE: "1" });
  });

  test("is null for an empty environ, one with no NUL end, and a value that is not UTF-8", () => {
    expect(hostEnvOfEnviron(Buffer.alloc(0))).toBeNull();
    expect(hostEnvOfEnviron(Buffer.from("HOME=/h"))).toBeNull();
    const bad = Buffer.concat([Buffer.from("CLAUDE_CONFIG_DIR=/a"), Buffer.from([0xfe, 0])]);
    expect(hostEnvOfEnviron(bad)).toBeNull();
  });
});
