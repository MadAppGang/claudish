import { test } from "bun:test";
import { runRoutingContractChild } from "../test-helpers/routing-contract-child.js";

for (const scenario of ["no-list", "unreadable", "missing-id"]) {
  test(
    `REQ-109 RB-4: a gateway-only rule returns gateway-id-unknown when its list is ${scenario}`,
    () =>
      runRoutingContractChild(
        new URL("./test-helpers/gateway-refusal-child.ts", import.meta.url).pathname,
        scenario
      ),
    20_000
  );
}
