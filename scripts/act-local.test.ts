import { describe, expect, test } from "bun:test";
import {
  BASE_TAG,
  CASE_TAG,
  IMAGE,
  PUSH_URL,
  RUNNABLE_JOBS,
  actArgv,
  actEnv,
  actrcPaths,
  dockerHostFor,
  parseArgs,
  runActLocal,
  runRefusal,
  tagEvent,
} from "./act-local.ts";
import type { ActArgs, ActDeps, ActMode } from "./act-local.ts";

const FILES = {
  secretFile: "/t/empty/secrets",
  varFile: "/t/empty/vars",
  envFile: "/t/empty/env",
  inputFile: "/t/empty/inputs",
};

const SECRET_FLAGS = ["-s", "--secret", "--var", "--env", "--input"];

function valueAfter(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

describe("parseArgs", () => {
  test("a real run takes --job and defaults the workflow to release.yml", () => {
    expect(parseArgs(["--job", "bundled-list"])).toEqual({
      job: "bundled-list",
      workflow: "release.yml",
      list: false,
      dryRun: false,
      keep: false,
    });
  });

  test("--tag-case accepts changed and unchanged, with --change for changed", () => {
    const changed = parseArgs(["--job", "bundled-list", "--tag-case", "changed"]) as ActArgs;
    expect(changed.tagCase).toBe("changed");
    const unchanged = parseArgs(["--job", "bundled-list", "--tag-case", "unchanged"]) as ActArgs;
    expect(unchanged.tagCase).toBe("unchanged");
    const withPath = parseArgs([
      "--job",
      "bundled-list",
      "--tag-case",
      "changed",
      "--change",
      "README.md",
    ]) as ActArgs;
    expect(withPath.change).toBe("README.md");
  });

  test("an unknown flag is refused", () => {
    expect(typeof parseArgs(["--job", "bundled-list", "--secret", "X=1"])).toBe("string");
    expect(typeof parseArgs(["--bogus"])).toBe("string");
  });

  test("a --tag-case other than changed or unchanged is refused", () => {
    expect(typeof parseArgs(["--job", "bundled-list", "--tag-case", "maybe"])).toBe("string");
    expect(typeof parseArgs(["--job", "bundled-list", "--tag-case"])).toBe("string");
  });

  test("--job is required for a real run only", () => {
    expect(typeof parseArgs([])).toBe("string");
    expect(typeof parseArgs(["--keep"])).toBe("string");
    expect((parseArgs(["--list"]) as ActArgs).list).toBe(true);
    expect((parseArgs(["--dry-run"]) as ActArgs).dryRun).toBe(true);
    expect((parseArgs(["--dry-run", "--job", "publish-npm"]) as ActArgs).job).toBe("publish-npm");
  });

  test("--list and --dry-run together are refused", () => {
    expect(typeof parseArgs(["--list", "--dry-run"])).toBe("string");
  });

  test("--change needs --tag-case changed and a path inside the repository", () => {
    expect(typeof parseArgs(["--job", "bundled-list", "--change", "a.txt"])).toBe("string");
    expect(
      typeof parseArgs(["--job", "bundled-list", "--tag-case", "unchanged", "--change", "a.txt"])
    ).toBe("string");
    for (const bad of ["/etc/passwd", "../x", "a/../../x"]) {
      expect(
        typeof parseArgs(["--job", "bundled-list", "--tag-case", "changed", "--change", bad])
      ).toBe("string");
    }
  });

  test("--workflow takes a file name under .github/workflows, never a path", () => {
    expect((parseArgs(["--list", "--workflow", "test.yml"]) as ActArgs).workflow).toBe("test.yml");
    for (const bad of ["../x.yml", "sub/x.yml", "x.txt", "/abs/x.yml"]) {
      expect(typeof parseArgs(["--list", "--workflow", bad])).toBe("string");
    }
  });
});

describe("runRefusal", () => {
  const run = (job: string, workflow = "release.yml"): ActArgs => ({
    job,
    workflow,
    list: false,
    dryRun: false,
    keep: false,
  });

  test("the allowlist runs bundled-list of release.yml", () => {
    expect(RUNNABLE_JOBS["release.yml"]).toEqual(["bundled-list"]);
    expect(runRefusal(run("bundled-list"))).toBeNull();
  });

  test("every other release.yml job is refused for a real run, naming the allowlist", () => {
    for (const job of ["publish-npm", "release", "update-homebrew", "build"]) {
      const refusal = runRefusal(run(job));
      expect(refusal).toContain(job);
      expect(refusal).toContain("RUNNABLE_JOBS");
      expect(refusal).toContain("bundled-list");
    }
  });

  test("a workflow absent from the allowlist is refused", () => {
    expect(runRefusal(run("rest", "test.yml"))).toContain("RUNNABLE_JOBS");
  });

  test("--list and --dry-run are never refused", () => {
    expect(runRefusal({ ...run("publish-npm"), list: true })).toBeNull();
    expect(runRefusal({ ...run("publish-npm"), dryRun: true })).toBeNull();
    expect(runRefusal({ workflow: "release.yml", list: false, dryRun: true, keep: false })).toBe(
      null
    );
  });
});

describe("actArgv", () => {
  const modes: { mode: ActMode; job?: string; eventFile?: string }[] = [
    { mode: "list" },
    { mode: "dry-run" },
    { mode: "dry-run", job: "publish-npm" },
    { mode: "run", job: "bundled-list" },
    { mode: "run", job: "bundled-list", eventFile: "/t/event.json" },
  ];

  for (const m of modes) {
    test(`${m.mode}${m.job ? ` ${m.job}` : ""}${m.eventFile ? " with an event" : ""}: every always-flag, no secret flag`, () => {
      const argv = actArgv({ workflow: "release.yml", ...m, ...FILES });
      expect(valueAfter(argv, "--secret-file")).toBe(FILES.secretFile);
      expect(valueAfter(argv, "--var-file")).toBe(FILES.varFile);
      expect(valueAfter(argv, "--env-file")).toBe(FILES.envFile);
      expect(valueAfter(argv, "--input-file")).toBe(FILES.inputFile);
      expect(argv).toContain("--rm");
      expect(valueAfter(argv, "--container-daemon-socket")).toBe("-");
      expect(valueAfter(argv, "--actor")).toBe("act-local");
      expect(argv).toContain(`ubuntu-latest=${IMAGE}`);
      expect(argv).toContain(`ubuntu-24.04-arm=${IMAGE}`);
      expect(argv).toContain("--pull=false");
      expect(valueAfter(argv, "-W")).toBe(".github/workflows/release.yml");
      for (const flag of SECRET_FLAGS) expect(argv).not.toContain(flag);
      for (const word of argv) {
        expect(word.startsWith("--secret=")).toBe(false);
        expect(word.startsWith("--var=")).toBe(false);
        expect(word.startsWith("--env=")).toBe(false);
        expect(word.startsWith("--input=")).toBe(false);
      }
    });
  }

  test("list mode lists, dry-run mode plans, run mode does neither", () => {
    const list = actArgv({ mode: "list", workflow: "release.yml", ...FILES });
    expect(list).toContain("-l");
    expect(list).not.toContain("-n");
    const dry = actArgv({ mode: "dry-run", workflow: "release.yml", ...FILES });
    expect(dry).toContain("-n");
    expect(dry[0]).toBe("push");
    const run = actArgv({ mode: "run", workflow: "release.yml", job: "bundled-list", ...FILES });
    expect(run).not.toContain("-n");
    expect(run).not.toContain("-l");
    expect(valueAfter(run, "-j")).toBe("bundled-list");
    expect(run).not.toContain("-e");
  });

  test("an event file is passed with -e only when given", () => {
    const argv = actArgv({
      mode: "run",
      workflow: "release.yml",
      job: "bundled-list",
      eventFile: "/t/event.json",
      ...FILES,
    });
    expect(valueAfter(argv, "-e")).toBe("/t/event.json");
  });
});

describe("actEnv", () => {
  const caller = {
    PATH: "/usr/bin",
    USER: "jack",
    LANG: "en_US.UTF-8",
    TMPDIR: "/var/tmp/",
    DOCKER_CONTEXT: "desktop-linux",
    HOME: "/Users/jack",
    XDG_CONFIG_HOME: "/Users/jack/.config",
    GITHUB_TOKEN: "ghs_x",
    GH_TOKEN: "gho_x",
    NPM_TOKEN: "npm_x",
    ANTHROPIC_API_KEY: "sk-ant-x",
    HOMEBREW_TAP_TOKEN: "x",
    ACT_SECRETS: "x",
  };
  const dirs = {
    home: "/t/home",
    xdgConfigHome: "/t/xdg-config",
    dockerHost: "unix:///Users/jack/.docker/run/docker.sock",
    dockerConfig: "/Users/jack/.docker",
  };

  test("only the allowlist passes, and secrets stay out", () => {
    const env = actEnv(caller, dirs);
    for (const key of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "NPM_TOKEN",
      "ANTHROPIC_API_KEY",
      "HOMEBREW_TAP_TOKEN",
      "ACT_SECRETS",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");
    expect(env.USER).toBe("jack");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TMPDIR).toBe("/var/tmp/");
    expect(env.DOCKER_CONTEXT).toBe("desktop-linux");
    expect(Object.keys(env).sort()).toEqual(
      [
        "PATH",
        "USER",
        "LANG",
        "TMPDIR",
        "DOCKER_CONTEXT",
        "HOME",
        "XDG_CONFIG_HOME",
        "DOCKER_HOST",
        "DOCKER_CONFIG",
      ].sort()
    );
  });

  test("HOME and XDG_CONFIG_HOME are the given temp dirs, Docker points at the caller's", () => {
    const env = actEnv(caller, dirs);
    expect(env.HOME).toBe("/t/home");
    expect(env.XDG_CONFIG_HOME).toBe("/t/xdg-config");
    expect(env.DOCKER_HOST).toBe(dirs.dockerHost);
    expect(env.DOCKER_CONFIG).toBe("/Users/jack/.docker");
  });

  test("an unset allowlisted variable is not invented", () => {
    const env = actEnv({ PATH: "/bin" }, dirs);
    expect(env.USER).toBeUndefined();
    expect(env.DOCKER_CONTEXT).toBeUndefined();
  });
});

describe("dockerHostFor", () => {
  const sock = "/Users/jack/.docker/run/docker.sock";

  test("the caller's DOCKER_HOST wins", () => {
    expect(dockerHostFor({ DOCKER_HOST: "tcp://h:2375" }, "/Users/jack", () => true)).toBe(
      "tcp://h:2375"
    );
  });

  test("else Docker Desktop's socket under the real HOME when it exists", () => {
    expect(dockerHostFor({}, "/Users/jack", (p) => p === sock)).toBe(`unix://${sock}`);
  });

  test("else the system socket", () => {
    expect(dockerHostFor({}, "/Users/jack", () => false)).toBe("unix:///var/run/docker.sock");
  });
});

describe("actrcPaths", () => {
  test("names every user and project actrc location", () => {
    expect(actrcPaths("/Users/jack", {}, "/t/repo")).toEqual([
      "/Users/jack/.actrc",
      "/Users/jack/.config/act/actrc",
      "/Users/jack/Library/Application Support/act/actrc",
      "/t/repo/.actrc",
    ]);
  });

  test("reads the caller's XDG_CONFIG_HOME", () => {
    expect(actrcPaths("/Users/jack", { XDG_CONFIG_HOME: "/x" }, "/t/repo")).toContain(
      "/x/act/actrc"
    );
  });
});

describe("tagEvent", () => {
  test("a push event for the tag ref", () => {
    expect(tagEvent(CASE_TAG)).toEqual({ ref: `refs/tags/${CASE_TAG}` });
    expect(BASE_TAG).not.toBe(CASE_TAG);
    expect(PUSH_URL).toBe("push-disabled-by-act-local");
  });
});

describe("runActLocal", () => {
  function fakeDeps(): { deps: ActDeps; started: string[][] } {
    const started: string[][] = [];
    const deps: ActDeps = {
      cwd: "/w",
      env: { PATH: "/bin", HOME: "/Users/jack" },
      realHome: "/Users/jack",
      git: () => {
        throw new Error("git must not run");
      },
      exists: () => false,
      makeTemp: () => {
        throw new Error("no temp dir must be made");
      },
      remove: () => {},
      spawnAct: async (argv) => {
        started.push(argv);
        return 0;
      },
    };
    return { deps, started };
  }

  test("a real run of publish-npm exits 2 and starts nothing", async () => {
    const { deps, started } = fakeDeps();
    expect(await runActLocal(["--job", "publish-npm"], deps)).toBe(2);
    expect(started).toEqual([]);
  });

  test("a usage error exits 2 and starts nothing", async () => {
    const { deps, started } = fakeDeps();
    expect(await runActLocal(["--nope"], deps)).toBe(2);
    expect(started).toEqual([]);
  });
});
