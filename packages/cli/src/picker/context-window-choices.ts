import { formatContextLength } from "../model-selector.js";

const COMMON_SIZES = [32_000, 64_000, 128_000, 256_000, 512_000];

/** A common size this close to the maximum would be a second row for the same choice. */
const NEAR_MAXIMUM = 0.9;

export interface ContextWindowChoice {
  size: number;
  label: string;
}

export interface ContextWindowChoices {
  choices: ContextWindowChoice[];
  defaultIndex: number;
}

/** The sizes a model can load with, ending at its real maximum. */
export function contextWindowChoices(max: number, defaultSize: number): ContextWindowChoices {
  const choices: ContextWindowChoice[] = COMMON_SIZES.filter(
    (size) => size < max * NEAR_MAXIMUM
  ).map((size) => ({ size, label: formatContextLength(size) }));
  choices.push({ size: max, label: `${formatContextLength(max)} (model maximum)` });

  const distance = (choice: ContextWindowChoice) => Math.abs(choice.size - defaultSize);
  const closest = choices.reduce((best, choice) =>
    distance(choice) < distance(best) ? choice : best
  );
  return { choices, defaultIndex: choices.indexOf(closest) };
}
