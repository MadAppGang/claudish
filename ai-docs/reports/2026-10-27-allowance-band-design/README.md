# Allowance band design (2026-10-27)

Terminal mockups for showing the Codex pool's allowance in the claudish mod band (above the
prompt), the status line, and the full forecast panel. Example data only; nothing here reads the
ledger. Run any file with `bun <file>`; each prints dark and light variants.

| File | Shows | Status |
|---|---|---|
| `band.ts` | the one-row band: profile chip, 5h/wk minis, pace gauge, rate, ruler, `[ Show ]` button | chosen |
| `gauge-colours.ts` | colour variants of the height gauge (E); G4 is the chosen one | reference |
| `status-line.ts` | status line forms; S3 (appended after the existing segments) is the chosen one | S3 chosen |
| `forecast-panel.ts` | the v12 forecast panel that `[ Show ]` opens | chosen |

## Decisions

- **One row, graphics, no words.** Profiles are shown by NUMBER in `account list` order, never by name.
- **Profile colours are vivid and avoid the meaning colours** (green, amber, red).
  Dark: `#B07CFF` `#4D9DFF` `#22D3EE` `#F472B6`. Light: `#7C3AED` `#2563EB` `#0891B2` `#DB2777`.
- **Pace gauge G4:** 9 cells, centre = safe pace, position `C + round(log2(perMin / safePerMin) * 4)`.
  Heights `▁▂▄▆█` grow away from the centre. The middle three cells are the safe band, in green.
  Left is under-use (amber, deeper as it grows), right is too fast (yellow → orange → red).
  Cells from the centre to the speed are lit; the rest are a tint of their own colour.
- **The rate takes the colour of the gauge's lit tip**, and plain text inside the safe band, so the
  two can never disagree.
- **Ruler:** now → 6d on a square-root scale, ticks 1h 6h 1d 3d. A profile badge sits where that
  profile takes over, `┈` marks the switch window, red `╳` marks a time with no allowance left.
  A tick label needs a free cell on each side.
- **Under-use badge K:** the wasting profile's number on its solid colour, then `−NN%` on a tint of
  that same colour. Two tones of one colour only.
- **`[ Show ]` / `[ Hide ]`** opens and closes the forecast panel, as a second pane with its own
  Pane handler (the mod's existing `button()` pattern).
- **No background of our own.** The band paints no page background; the terminal theme owns it, and
  a badge cell ends with `\x1b[49m`. The theme picks only the light or dark colour set. Tints mix
  toward the background colour OSC 11 reports, with `#16171D` / `#FFFFFF` only when it does not answer.

## Open questions

- Whether a profile's colour is stored with the account: numbers shift when a profile is removed.
