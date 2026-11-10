import { test } from "bun:test";
import { runRoutingContractChild } from "../test-helpers/routing-contract-child.js";

for (const [scenario, outcome] of [
  ["parent-pin", "sends a one-spec parent pin as a routed hop offline"],
  ["typed-spec", "refuses the same explicit spec with no bundled connection"],
  ["typed-chain", "refuses a user-typed + chain without converting it to routed hops"],
  ["spoofed-pin", "ignores a direct CLI caller's pin flag and retains the explicit refusal"],
]) {
  test(
    `REQ-106 REQ-107 RB-2 RB-27: ${outcome}`,
    () =>
      runRoutingContractChild(
        new URL("./test-helpers/model-pinned-child.ts", import.meta.url).pathname,
        scenario!
      ),
    20_000
  );
}
