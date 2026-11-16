/** @jsxImportSource @opentui/react */
/**
 * The provider list's shortcut column, rendered: it is as wide as the widest
 * shortcut the list shows, so `anthropic@` prints whole beside `Claude API`,
 * and the extra cell it takes never cuts the longest provider name at 80 columns.
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ModelPicker } from "./ModelPicker.js";
import type { PickerDataSource, PickerProviderChoice } from "./PickerDataSource.js";

function choice(
  value: string,
  label: string,
  shortcut: string,
  billing: PickerProviderChoice["billing"]
): PickerProviderChoice {
  return {
    value,
    label,
    shortcut,
    description: label,
    billing,
    envVar: "",
    hasDiscovery: false,
    discoveryShape: "none",
  };
}

const PROVIDERS: PickerProviderChoice[] = [
  choice("native-anthropic", "Claude subscription", "claude@", "sub"),
  choice("anthropic", "Claude API", "anthropic@", "metered"),
  choice("grok-build", "Grok Build (subscription)", "gb@", "sub"),
];

function source(): PickerDataSource {
  return {
    providerList: () => PROVIDERS,
    notEnabledLocalProviders: () => [],
    displayName: (provider) => PROVIDERS.find((p) => p.value === provider)?.label ?? provider,
    async *probeCredentials(names) {
      for (const name of names) yield [name, true] as [string, boolean];
    },
    async ensureCatalog() {},
    servedModels: () => [],
    async discoverModelsCatalog() {
      return { kind: "unsupported", reason: "no-descriptor" };
    },
    async descriptions() {
      return { get: () => undefined, size: 0 };
    },
  };
}

async function providerListFrame(width: number): Promise<string> {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ModelPicker source={source()} onDone={() => {}} />,
    { width, height: 30 }
  );
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      await act(async () => {
        await renderOnce();
      });
      const frame = captureCharFrame();
      if (frame.includes(`${PROVIDERS.length} of ${PROVIDERS.length} have credentials`)) {
        return frame;
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    throw new Error(`Picker did not settle its credential sweep:\n${captureCharFrame()}`);
  } finally {
    await act(async () => {
      renderer.destroy();
    });
  }
}

/** The list row of one provider: its readiness glyph, then its name. */
function providerRow(frame: string, label: string): string {
  const row = frame.split("\n").find((line) => line.includes(`● ${label} `));
  expect(row).toBeDefined();
  return row ?? "";
}

test.each([80, 100])(
  "at %i columns the Claude API row prints `anthropic@` whole",
  async (width) => {
    const frame = await providerListFrame(width);

    expect(providerRow(frame, "Claude API")).toMatch(/● Claude API +anthropic@ /);
    expect(providerRow(frame, "Claude subscription")).toMatch(/● Claude subscription +claude@ /);
  }
);

test("the wider shortcut column leaves the longest provider name whole at 80 columns", async () => {
  const frame = await providerListFrame(80);

  expect(providerRow(frame, "Grok Build (subscription)")).toMatch(
    /● Grok Build \(subscription\) +gb@ /
  );
});
