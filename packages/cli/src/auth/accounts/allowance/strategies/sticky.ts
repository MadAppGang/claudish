/**
 * `sticky` (architecture §1.6): today's rule, and the default. Nothing about it
 * is modelled — `decide` calls the REAL `policy.ts` `selectAccount` with no
 * `rank`, over `viewsToCandidates(views)`: the active account (a0) while under
 * SELECTION_THRESHOLD; else the first under threshold in config order; else
 * the lowest pressure. The simulator therefore measures the production
 * function itself.
 */

import { selectAccount } from "../../policy.js";
import { accountProviderOf, viewsToCandidates } from "../request.js";
import type { Decision, Strategy } from "../types.js";

export const sticky: Strategy = {
  name: "sticky",
  decide(input, _plan, cfg): Decision {
    const candidates = viewsToCandidates(input.views, input, accountProviderOf(cfg));
    const result = selectAccount(candidates, {
      now: input.now,
      switchAt: cfg.SELECTION_THRESHOLD,
    });
    if (result.kind !== "selected") return { account: null, reason: "sticky", usedPlan: false };
    // With no pin and no rank, `selectAccount` answers only with steps 2–4.
    const reason =
      result.reason === "first-under-threshold" || result.reason === "lowest-pressure"
        ? result.reason
        : "sticky";
    return { account: result.candidate.ref.id, reason, usedPlan: false };
  },
};
