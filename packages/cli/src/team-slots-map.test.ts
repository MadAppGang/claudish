import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupSession, slotsOfManifest, teamRunRowFromDisk } from "./team-orchestrator.js";
import { readTeamStatus } from "./team-orchestrator.js";

/*
 * The `slots` map of a `team run` answer: display model → slot id. A model listed more
 * than once keeps its bare id for the first slot and takes `<model>#2`, `<model>#3`, …
 * for the later ones, so no slot is dropped from the map by a later one overwriting it.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function session(models: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "team-slots-map-"));
  dirs.push(dir);
  const path = join(dir, "run");
  const manifest = setupSession(path, models, "Answer the question.");
  return { path, manifest };
}

describe("slotsOfManifest — model ids that name Object.prototype members", () => {
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "keeps a slot whose literal model id is %s",
    (model) => {
      const { manifest } = session([model, "b", model]);
      const [first, second, third] = manifest.shuffleOrder;
      const slots = slotsOfManifest(manifest);

      expect(Object.keys(slots)).toEqual([model, "b", `${model}#2`]);
      expect(Object.getOwnPropertyDescriptor(slots, model)?.value).toBe(first);
      expect(JSON.parse(JSON.stringify(slots))).toEqual(
        JSON.parse(`{${JSON.stringify(model)}:"${first}","b":"${second}","${model}#2":"${third}"}`)
      );
      expect(JSON.stringify(slots)).toBe(
        `{${JSON.stringify(model)}:"${first}","b":"${second}","${model}#2":"${third}"}`
      );
    }
  );
});

describe("slotsOfManifest", () => {
  it("numbers a repeated model's later slots and keeps the bare id for the first", () => {
    const { manifest } = session(["a", "a", "b"]);
    const [first, second, third] = manifest.shuffleOrder;

    expect(slotsOfManifest(manifest)).toEqual({ a: first, "a#2": second, b: third });
  });

  it("puts every slot of the run in the map, and every slot in run.slots", () => {
    const { path, manifest } = session(["a", "a", "b", "a"]);
    const slots = slotsOfManifest(manifest);

    expect(Object.keys(slots).sort()).toEqual(["a", "a#2", "a#3", "b"]);
    expect(Object.values(slots).sort()).toEqual(["01", "02", "03", "04"]);
    const run = teamRunRowFromDisk(path, readTeamStatus(path));
    expect(run.slots.map((s) => s.slot)).toEqual(["01", "02", "03", "04"]);
    // run.slots[] still names each slot's bare model
    for (const [key, id] of Object.entries(slots))
      expect(run.slots.find((s) => s.slot === id)?.model).toBe(key.replace(/#\d+$/, ""));
  });

  it("leaves a map of distinct models unchanged", () => {
    const { manifest } = session(["x", "y"]);
    const [first, second] = manifest.shuffleOrder;

    expect(slotsOfManifest(manifest)).toEqual({ x: first, y: second });
  });

  it("never gives a later slot a key that is another model's own id", () => {
    const { manifest } = session(["a", "a", "a#2"]);
    const [first, second, third] = manifest.shuffleOrder;

    expect(slotsOfManifest(manifest)).toEqual({ a: first, "a#3": second, "a#2": third });
  });

  it("skips a taken key whichever order the literal model comes in", () => {
    const { manifest } = session(["a#2", "a", "a", "a"]);
    const [lit, first, second, third] = manifest.shuffleOrder;

    expect(slotsOfManifest(manifest)).toEqual({
      "a#2": lit,
      a: first,
      "a#3": second,
      "a#4": third,
    });
  });
});
