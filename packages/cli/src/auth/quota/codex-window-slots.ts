/** Stable Codex header positions, never plan-window durations. */
export const CODEX_WINDOW_SLOTS = [
  {
    pct: "x-codex-primary-used-percent",
    reset: "x-codex-primary-reset-at",
    minutes: "x-codex-primary-window-minutes",
    fallbackId: "primary",
  },
  {
    pct: "x-codex-secondary-used-percent",
    reset: "x-codex-secondary-reset-at",
    minutes: "x-codex-secondary-window-minutes",
    fallbackId: "secondary",
  },
] as const;
