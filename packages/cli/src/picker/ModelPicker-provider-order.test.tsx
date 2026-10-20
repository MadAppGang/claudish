/** @jsxImportSource @opentui/react */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { _resetAgyClientVersion } from "../auth/antigravity-client-version.js";
import { _resetAntigravityTokenState } from "../auth/antigravity-token.js";
import { _resetAntigravityServedModelsCache, resetAntigravityUserCache } from "../auth/antigravity-user.js";
import type { ModelInfo, PickerDiscoveryOutcome } from "../model-selector.js";
import { ModelPicker } from "./ModelPicker.js";
import type { PickerDataSource } from "./PickerDataSource.js";

const realFetch = globalThis.fetch;
function resetState(): void {
  _resetAgyClientVersion();
  _resetAntigravityServedModelsCache();
  resetAntigravityUserCache();
  _resetAntigravityTokenState();
}
beforeEach(() => {
  resetState();
  globalThis.fetch = mock(async () => { throw new Error("Unexpected network request"); }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  resetState();
});

function source(providerOrdered: boolean): PickerDataSource {
  const row: ModelInfo = {
    id: "gemini-4-argon-medium",
    name: "gemini-4-argon-medium",
    description: "Offline rendered model",
    provider: "Antigravity",
    contextLength: 1_048_576,
    context: "1M",
    supportsTools: true,
  };
  const outcome: PickerDiscoveryOutcome = {
    kind: "rows", rows: [row], servedCount: 1, chatCount: 1,
    ...(providerOrdered ? { providerOrdered: true as const } : {}),
  };
  return {
    providerList: () => [{
      value: "antigravity", label: "Antigravity", shortcut: "ag@",
      description: "Subscription", billing: "sub", envVar: "",
      hasDiscovery: true, discoveryShape: "deadline",
    }],
    notEnabledLocalProviders: () => [],
    displayName: () => "Antigravity",
    async *probeCredentials(names) {
      for (const name of names) yield [name, true] as [string, boolean];
    },
    async ensureCatalog() {},
    servedModels: () => [],
    async discoverModelsCatalog() { return outcome; },
    async descriptions() { return { get: () => undefined, size: 0 }; },
  };
}

test.each([true, false])("B11: providerOrdered=%s controls the model filter's newest-first caption", async (providerOrdered) => {
  const { renderer, renderOnce, captureCharFrame, mockInput } = await testRender(
    <ModelPicker source={source(providerOrdered)} onDone={() => {}} />,
    { width: 100, height: 30 }
  );
  try {
    // Let mount effects install keyboard handling before the first input.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await renderOnce();
    });
    async function waitFor(text: string): Promise<string> {
      for (let attempt = 0; attempt < 40; attempt++) {
        await act(async () => { await renderOnce(); });
        const frame = captureCharFrame();
        if (frame.includes(text)) return frame;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
      }
      throw new Error(`Picker did not paint ${text}:\n${captureCharFrame()}`);
    }
    await waitFor("1 of 1 have credentials");
    await act(async () => {
      await mockInput.pressKeys(["RETURN"]);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // Wait for the actual model row, never for the caption being tested.
    const frame = await waitFor("gemini-4-argon-medium");
    expect(frame).toContain("gemini-4-argon-medium");
    if (providerOrdered) expect(frame).not.toContain("newest first");
    else expect(frame).toContain("newest first");
  } finally {
    await act(async () => { renderer.destroy(); });
  }
});
