/** Normalize provider/context decorations before comparing model version tuples. */
export function normalizeModelId(modelId: string): string {
  const explicitModel = modelId.includes("@") ? modelId.slice(modelId.indexOf("@") + 1) : modelId;
  return explicitModel.replace(/\[[^\]]+\]$/u, "").toLowerCase();
}

/** Extract the leading numeric version sequence from a model identifier. */
export function extractVersionParts(modelId: string): number[] {
  const tokens = normalizeModelId(modelId).split(/[\/_-]+/);
  let started = false;
  const parts: number[] = [];

  for (const token of tokens) {
    const match = token.match(/\d+(?:\.\d+)*/);
    if (!match) {
      if (started) break;
      continue;
    }

    if (!started) {
      started = true;
      for (const part of match[0].split(".")) {
        parts.push(Number.parseInt(part, 10));
      }
      if (!/^\d+(?:\.\d+)*$/.test(token)) break;
      continue;
    }

    if (!/^\d{1,2}(?:\.\d+)?$/.test(token)) break;
    for (const part of token.split(".")) {
      parts.push(Number.parseInt(part, 10));
    }
  }

  return parts;
}

/** Ascending semantic comparison: positive means `a` is newer than `b`. */
export function compareModelVersions(a: string, b: string): number {
  const aParts = extractVersionParts(a);
  const bParts = extractVersionParts(b);
  const maxLength = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLength; i++) {
    const aPart = aParts[i] ?? -1;
    const bPart = bParts[i] ?? -1;
    if (aPart !== bPart) return aPart - bPart;
  }
  return 0;
}

export function compareVersionPartsDesc(a: number[], b: number[]): number {
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i++) {
    const aPart = a[i] ?? -1;
    const bPart = b[i] ?? -1;
    if (aPart !== bPart) return bPart - aPart;
  }
  return 0;
}
