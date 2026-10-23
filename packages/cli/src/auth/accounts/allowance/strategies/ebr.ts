/**
 * `ebr`, earliest binding reset (architecture §1.6): the feasible account whose
 * BINDING window resets first, then config order. When two windows of one
 * account tie for binding, the one with the earlier reset binds (`finishView`).
 * With only a governing window, `ebr` is governing-reset FEFO.
 *
 * A live thread stays on a feasible a0 until SWITCH_DWELL has passed since its
 * last switch. It is the cheapest non-sticky contestant and needs no plan: the
 * control that shows what the lookahead search buys (§7 Q16). No optimality is
 * claimed; by the hand figures it serves 3 of 4 on gpt #1.
 *
 * Feasible = usable and not hard-full for THIS request (§1.8 step 2). An unread
 * account is chosen only when no read account is feasible (`ebr-unknown-usage`):
 * it is learned from that real response, and no quota is spent to learn.
 */

import { feasible, isRead } from "../capacity.js";
import type { AccountView, ChooseReason, Decision, Strategy } from "../types.js";

/** When the binding window resets; +∞ when it never says. */
export function bindingResetAt(view: AccountView): number {
  const w = view.windows.find((x) => x.key === view.binding);
  return w?.resetAt ?? Number.POSITIVE_INFINITY;
}

/** EBR order: earliest binding reset, then config order. */
export function byBindingReset(a: AccountView, b: AccountView): number {
  const ra = bindingResetAt(a);
  const rb = bindingResetAt(b);
  if (ra !== rb) return ra < rb ? -1 : 1; // never ∞ − ∞
  return a.order - b.order;
}

function decision(account: string, reason: ChooseReason): Decision {
  return { account, reason, usedPlan: false };
}

export const ebr: Strategy = {
  name: "ebr",
  decide(input, _plan, cfg): Decision {
    const ctx = input.thread.contextTokens;
    const ok = input.views.filter((v) => feasible(v, ctx, cfg));
    const a0 = input.thread.account ?? input.poolActive;
    const a0View = a0 === null ? undefined : ok.find((v) => v.account === a0);

    // Dwell: a live thread whose last switch is recent stays where it is.
    const dwelling =
      input.thread.account !== null &&
      input.thread.lastSwitchAt !== null &&
      input.now - input.thread.lastSwitchAt < cfg.SWITCH_DWELL_MS;
    if (a0View && dwelling) return decision(a0View.account, "ebr-sticky");

    const best = ok.filter(isRead).sort(byBindingReset)[0];
    if (best) {
      if (a0 === null) return decision(best.account, "ebr-initial");
      if (!a0View) return decision(best.account, "ebr-forced");
      return best.account === a0
        ? decision(best.account, "ebr-sticky")
        : decision(best.account, "ebr-switch");
    }
    if (a0View) return decision(a0View.account, "ebr-sticky");
    const unread = ok.filter((v) => !isRead(v)).sort((a, b) => a.order - b.order)[0];
    if (unread) return decision(unread.account, "ebr-unknown-usage");
    return { account: null, reason: "ebr-forced", usedPlan: false };
  },
};
