import { describe, expect, test } from "bun:test";
/**
 * The picker's PUBLIC CONTRACT — what the two call sites are allowed to assume.
 *
 * FR-5 is that `selectModel(options)` still resolves to a model spec string and that
 * `index.ts` and `profile-commands.ts` keep working. The success path cannot be driven
 * from a unit test (it needs a terminal and a human), so this file pins the parts that
 * CAN be decided without one: the non-TTY refusal, the shape of the cancel error, and —
 * at the source level — that the two call sites still look the way the contract says
 * they do. The last of those is a grep, and a grep is the only mechanism that catches a
 * call site quietly changing shape while every type still checks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectModel, selectModelInteractive } from "./model-selector.js";
import { NO_TTY_LINES, NoTtyError, PickerCancelled } from "./tui/runtime/picker-cancelled.js";

const SRC = new URL(".", import.meta.url).pathname;
const read = (f: string): string => readFileSync(join(SRC, f), "utf8");

/**
 * Force the non-TTY answer rather than depending on how the suite was launched.
 *
 * `bun test` at a terminal INHERITS that terminal, so an unguarded assertion here would
 * open a full-screen picker in the middle of a test run on a developer's machine and
 * block until they pressed Escape. Setting the flags makes the test decide the same
 * thing in both environments — which is the whole point of `canDrawTui` reading the
 * live process rather than a module-load constant.
 */
async function withoutTty<T>(fn: () => Promise<T>): Promise<T> {
  // `defineProperty`, not assignment: on a stream that really IS a terminal, `isTTY` is
  // a READONLY property and a plain assignment throws `TypeError: Attempted to assign to
  // readonly property`. Measured — this file passed alone (piped stdin, where the
  // property does not exist and assignment silently creates it) and failed inside the
  // full suite, which inherits the developer's terminal. Restoring the ORIGINAL
  // descriptor matters for the same reason: deleting the property would leave a real TTY
  // looking piped for every test file that runs after this one, in the same process.
  const streams = [process.stdin, process.stdout] as const;
  const saved = streams.map((s) => Object.getOwnPropertyDescriptor(s, "isTTY"));
  for (const s of streams) {
    Object.defineProperty(s, "isTTY", { value: false, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    streams.forEach((s, i) => {
      const d = saved[i];
      if (d) Object.defineProperty(s, "isTTY", d);
      else Reflect.deleteProperty(s as object, "isTTY");
    });
  }
}

describe("selectModelInteractive", () => {
  test("refuses a non-TTY with NoTtyError — never a fallback to inquirer", async () => {
    // Falling back would be falling back to a HANG: inquirer in a non-TTY draws into a
    // stream nothing is reading and then waits for a keypress that cannot arrive.
    // `claudish profile edit` under a pipe reaches exactly this branch.
    await withoutTty(async () => {
      await expect(selectModelInteractive()).rejects.toBeInstanceOf(NoTtyError);
    });
  });

  test("the refusal carries the same lines the non-interactive path prints", async () => {
    await withoutTty(async () => {
      const err = await selectModelInteractive().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NoTtyError);
      for (const line of NO_TTY_LINES) expect((err as Error).message).toContain(line);
    });
  });

  test("`selectModel` propagates NoTtyError rather than reporting a cancel", async () => {
    // A cancel exits 0. An environment that cannot ask must NOT look like a user who
    // declined — that is an exit 0 with no model chosen, which a headless caller reads
    // as success.
    await withoutTty(async () => {
      const err = await selectModel().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NoTtyError);
      expect(err).not.toBeInstanceOf(PickerCancelled);
    });
  });
});

describe("PickerCancelled", () => {
  test("is an Error with a stable name, so a cross-module `instanceof` is not the only handle", () => {
    const err = new PickerCancelled();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PickerCancelled");
  });
});

describe("the two call sites still look the way the contract says", () => {
  test("index.ts calls selectModel through handlePromptExit, which handles PickerCancelled", () => {
    const src = read("index.ts");
    expect(src).toContain(
      "selectModel({ freeOnly: cliConfig.freeOnly, onContextWindow }).catch(handlePromptExit)"
    );
    expect(src).toContain("if (err instanceof PickerCancelled)");
    // And NOT `NoTtyError` — that one must surface and exit non-zero.
    expect(src).not.toContain("instanceof NoTtyError");
  });

  test("profile-commands.ts still calls selectModel and is otherwise untouched", () => {
    const src = read("profile-commands.ts");
    expect(src).toContain("selectModel({");
    // It reaches `handlePromptExit` through `index.ts`'s own `.catch`, so it needs no
    // knowledge of the cancel type at all — which is what "zero call sites change"
    // means here.
    expect(src).not.toContain("PickerCancelled");
  });

  test("selectModel resolves to a string — the signature FR-5 pins", () => {
    // Compile-time, made visible: if the return type ever widened, this line would stop
    // type-checking and `tsc` would name this file.
    const fn: (o?: { message?: string }) => Promise<string> = selectModel;
    expect(typeof fn).toBe("function");
  });
});
