import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBuiltAppMod, herdrCommand, sidebarRowsToml } from "./herdr-cli.js";

describe("claudish herdr rows", () => {
  test("prints global agent rows with the claudish tokens and herdr's default rows kept", () => {
    let out = "";
    expect(
      herdrCommand(["rows"], (s) => {
        out += s;
      })
    ).toBe(0);
    expect(out).toBe(sidebarRowsToml());
    expect(out).toContain("[ui.sidebar.agents]");
    expect(out).toContain('["state_icon", "machine", "workspace", "tab"]');
    expect(out).toContain('["$model", "$activity", "$tokens"]');
    expect(out).not.toContain("rows_by_agent");
  });

  test("anything else prints the usage and exits 2", () => {
    let out = "";
    expect(
      herdrCommand([], (s) => {
        out += s;
      })
    ).toBe(2);
    expect(out).toContain("usage: claudish herdr rows");
  });
});

describe("claudish herdr install-app-mod", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** a temp HOME, a built mod folder, and a run of the command with that HOME */
  function setup(o: { appHome?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), "cph-home-"));
    const build = mkdtempSync(join(tmpdir(), "cph-mod-"));
    made.push(home, build);
    writeFileSync(join(build, "main.js"), "export default class X {}\n");
    writeFileSync(join(build, "mod.json"), '{ "place": "right" }\n');
    writeFileSync(join(build, ".hidden"), "never copied\n");
    // what `herdr-app check` writes into a folder it checked: Herdr's own, never copied
    writeFileSync(join(build, "gpui-kit.d.ts"), "declare module 'gpui-kit';\n");
    writeFileSync(join(build, "jsconfig.json"), "{}\n");
    if (o.appHome !== false) mkdirSync(join(home, ".config", "herdr-app"), { recursive: true });
    const run = (args: string[], env: Record<string, string> = { HOME: home }) => {
      let out = "";
      let err = "";
      const code = herdrCommand(
        ["install-app-mod", ...args],
        (s) => {
          out += s;
        },
        {
          env,
          modSource: build,
          err: (s) => {
            err += s;
          },
        }
      );
      return { code, out, err };
    };
    return { home, build, run };
  }

  test("copies main.js and mod.json into the temp HOME's Herdr.app mods/claudish", () => {
    const { home, run } = setup();
    const r = run([]);
    const dest = join(home, ".config", "herdr-app", "mods", "claudish");
    expect(r).toEqual({
      code: 0,
      out: `installed the claudish mod in ${dest}\ncheck it with: herdr-app check ${dest}\n`,
      err: "",
    });
    expect(readdirSync(dest).sort()).toEqual(["main.js", "mod.json"]);
    expect(readFileSync(join(dest, "main.js"), "utf8")).toBe("export default class X {}\n");
    // installing again replaces the files and leaves nothing half-written beside them
    writeFileSync(join(dest, "main.js"), "old\n");
    expect(run([]).code).toBe(0);
    expect(readFileSync(join(dest, "main.js"), "utf8")).toBe("export default class X {}\n");
    expect(readdirSync(dest).sort()).toEqual(["main.js", "mod.json"]);
  });

  test("HERDR_APP_HOME picks another Herdr.app home", () => {
    const { home, run } = setup({ appHome: false });
    const other = join(home, "other-app-home");
    mkdirSync(other);
    expect(run([], { HOME: home, HERDR_APP_HOME: other }).code).toBe(0);
    expect(readdirSync(join(other, "mods", "claudish")).sort()).toEqual(["main.js", "mod.json"]);
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  test("refuses, and creates nothing, when Herdr.app has never run under this HOME", () => {
    const { home, run } = setup({ appHome: false });
    const r = run([]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("start Herdr.app once");
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  test("refuses a folder without a built mod, and stray arguments", () => {
    const { run, home } = setup();
    const empty = mkdtempSync(join(tmpdir(), "cph-empty-"));
    made.push(empty);
    const r = run(["--from", empty]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("holds no built mod");
    expect(existsSync(join(home, ".config", "herdr-app", "mods"))).toBe(false);
    expect(run(["--force"]).code).toBe(2);
  });

  test("the built mod is found beside this claudish from its source or dist folder", () => {
    const pkg = mkdtempSync(join(tmpdir(), "cph-pkg-"));
    made.push(pkg);
    const built = join(pkg, "herdr-app-mod", "claudish");
    mkdirSync(built, { recursive: true });
    mkdirSync(join(pkg, "src", "herdr"), { recursive: true });
    writeFileSync(join(built, "main.js"), "x");
    writeFileSync(join(built, "mod.json"), "{}");
    expect(findBuiltAppMod(join(pkg, "src", "herdr"))).toBe(built);
    expect(findBuiltAppMod(join(pkg, "dist"))).toBe(built);
    rmSync(join(built, "mod.json"));
    expect(findBuiltAppMod(join(pkg, "src", "herdr"))).toBeNull();
  });
});
