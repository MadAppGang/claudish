/**
 * SpecRefusalWithLimit: with a --context-window limit set, a running LM
 * Studio instance smaller than the request is still refused, and the refusal
 * names the flag with the running size. Turn 1 of long-session-xl: "When
 * `ensureLMStudioInstance` refuses because a running instance has a smaller
 * window, the message names the flag with the running size". Written after
 * the first XL results; reported beside Graded, never folded into it. The
 * in-memory LM Studio below is the hidden lmstudio-devices test's, unchanged.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type LmsRunner, ensureLMStudioInstance } from "./lmstudio-devices.js";

const SELF = "self-id";
const M1 = "m1-id";
const BASE = "http://localhost:1234";

interface Row {
  identifier: string;
  modelKey: string;
  deviceIdentifier: string | null;
  contextLength: number;
}

let preferred: string;
let loaded: Row[];
let stored: { modelKey: string; deviceIdentifier: string | null; maxContextLength?: number }[];
let lmsLoads: string[][];
let lmsLoadFails: boolean;
let lastLoadBody: unknown;
let contextLengthAfterLoad: number;
let preferredWrites: string[];
let loadStatus: number;
/** Where the next load lands, when it must not follow the preferred device. */
let loadsOn: string | undefined;

const run: LmsRunner = async (args) => {
  const command = args.join(" ");
  if (command === "link status --json") {
    return JSON.stringify({
      deviceIdentifier: SELF,
      preferredDeviceIdentifier: preferred,
      peers: [
        { deviceIdentifier: M1, deviceName: "m1", status: "connected" },
        { deviceIdentifier: "gone-id", deviceName: "gone", status: "disconnected" },
      ],
    });
  }
  if (command === "ls --json") return JSON.stringify(stored);
  if (command === "ps --json") return JSON.stringify(loaded);
  if (args[0] === "load") {
    if (lmsLoadFails) return null;
    lmsLoads.push(args.slice(1));
    loaded.push({
      identifier: args[3] as string,
      modelKey: args[1] as string,
      deviceIdentifier: null,
      contextLength: 64_000,
    });
    return "";
  }
  if (args[0] === "link" && args[1] === "set-preferred-device") {
    preferred = args[2] as string;
    preferredWrites.push(preferred);
    return "";
  }
  throw new Error(`unexpected lms ${command}`);
};

const realFetch = globalThis.fetch;
let savedLimit: string | undefined;

beforeEach(() => {
  preferred = M1;
  loaded = [];
  stored = [
    { modelKey: "both", deviceIdentifier: null },
    { modelKey: "both", deviceIdentifier: M1 },
    { modelKey: "only-m1", deviceIdentifier: M1 },
    { modelKey: "only-here", deviceIdentifier: null },
    { modelKey: "on-gone", deviceIdentifier: "gone-id" },
  ];
  preferredWrites = [];
  lmsLoads = [];
  lmsLoadFails = false;
  lastLoadBody = undefined;
  contextLengthAfterLoad = 64_000;
  loadStatus = 200;
  loadsOn = undefined;
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    if (loadStatus !== 200) return new Response("no memory", { status: loadStatus });
    lastLoadBody = JSON.parse(String(init?.body));
    const { model } = lastLoadBody as { model: string };
    const device = loadsOn ?? preferred;
    loaded.push({
      identifier: model,
      modelKey: model,
      deviceIdentifier: device === SELF ? null : device,
      contextLength: contextLengthAfterLoad,
    });
    return Response.json({ instance_id: model, status: "loaded" });
  }) as unknown as typeof fetch;
  // The limit --context-window 64000 sets.
  savedLimit = process.env.CLAUDISH_CONTEXT_WINDOW;
  process.env.CLAUDISH_CONTEXT_WINDOW = "64000";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedLimit === undefined) delete process.env.CLAUDISH_CONTEXT_WINDOW;
  else process.env.CLAUDISH_CONTEXT_WINDOW = savedLimit;
});

describe("ensureLMStudioInstance with a limit set", () => {
  const ensure = (model: string, device: string, contextLength?: number) =>
    ensureLMStudioInstance({ baseUrl: BASE, model, device, contextLength, run });

  test("a running instance smaller than the limit is refused with both sizes", async () => {
    loaded = [{ identifier: "both", modelKey: "both", deviceIdentifier: M1, contextLength: 8_192 }];

    await expect(ensure("both", "m1", 64_000)).rejects.toThrow(/8192.*64000/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("the refusal names the flag with the running size", async () => {
    loaded = [{ identifier: "both", modelKey: "both", deviceIdentifier: M1, contextLength: 8_192 }];

    await expect(ensure("both", "m1", 64_000)).rejects.toThrow("--context-window 8192");
  });
});
