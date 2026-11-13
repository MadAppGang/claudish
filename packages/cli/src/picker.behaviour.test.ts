import { expect, test } from "bun:test";
import { isolatedFile, MODEL } from "./test-helpers/claude-behaviour.js";
await isolatedFile(import.meta, async () => {
  const { buildProviderChoices, buildExplicitModelSpec, providerShortcut, displayBillingOf } = await import("./model-selector.js");
  const { pickerProviderReady } = await import("./providers/picker-readiness.js");
  const { billingModeOf } = await import("./picker/PickerDataSource.js");
  const { resolveProviderDetailKeyDisplay } = await import("./tui/components/ProviderDetail.js");

  test("B-13 offers subscription then API with distinct billing", () => {
    const choices = buildProviderChoices();
    expect(choices[0].value).toBe("skip");
    expect(choices.slice(1, 3)).toEqual([
      expect.objectContaining({ name: "Claude subscription", value: "native-anthropic" }),
      expect.objectContaining({ name: "Claude API", value: "anthropic" }),
    ]);
    expect(displayBillingOf("native-anthropic")).toBe("sub");
    expect(displayBillingOf("anthropic")).toBe("metered");
    expect(billingModeOf("native-anthropic")).toBe("sub");
    expect(billingModeOf("anthropic")).toBe("metered");
  });

  test("B-18 builds explicit subscription and API specs", () => {
    expect(buildExplicitModelSpec("native-anthropic", MODEL)).toBe("claude@" + MODEL);
    expect(buildExplicitModelSpec("anthropic", MODEL)).toBe("anthropic@" + MODEL);
    expect(providerShortcut("native-anthropic")).toBe("claude@");
    expect(providerShortcut("anthropic")).toBe("anthropic@");
  });

  test("B-19 uses login readiness only for the subscription", async () => {
    const forbidden = async () => { throw new Error("subscription readiness must not consult API availability"); };
    expect(await pickerProviderReady("native-anthropic", { hasLogin: () => true, isAvailable: forbidden })).toBe(true);
    expect(await pickerProviderReady("native-anthropic", { hasLogin: () => false, isAvailable: async () => true })).toBe(false);
    expect(await pickerProviderReady("native-anthropic", { hasLogin: () => { throw new Error("unreadable login"); }, isAvailable: forbidden })).toBe(false);
    expect(await pickerProviderReady("anthropic", { isAvailable: async () => true })).toBe(true);
    expect(await pickerProviderReady("anthropic", { isAvailable: async () => { throw new Error("unreadable key"); } })).toBe(false);
  });

  test("B-93 displays read-at-use vault sources without treating placeholders as keys", () => {
    // AuthSource's union is omitted from the contract; the vault branch is independent of it.
    const base = {
      isLocal: false, isReady: true, authSource: "api-key",
      hasEnvKey: false, hasCfgKey: false, envKeyMask: "", cfgKeyMask: "",
    } as unknown as Parameters<typeof resolveProviderDetailKeyDisplay>[0];
    expect(resolveProviderDetailKeyDisplay({ ...base, vaultKeySource: "macOS Keychain", vaultKeyMask: "sk-a...0000" })).toBe("sk-a...0000");
    expect(resolveProviderDetailKeyDisplay({ ...base, vaultKeySource: "macOS Keychain" })).toBe("keychain");
    expect(resolveProviderDetailKeyDisplay({ ...base, vaultKeySource: "1Password" })).toBe("1Password");
  });
});
