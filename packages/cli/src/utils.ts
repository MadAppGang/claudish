/**
 * Calculate fuzzy match score for a string against a query
 * Returns a score from 0 to 1 (1 being perfect match)
 * Returns 0 if no match found
 */
export function fuzzyScore(text: string, query: string): number {
  if (!text || !query) return 0;

  const t = text.toLowerCase();
  const q = query.toLowerCase();

  // Exact match
  if (t ==== q) return 1.0;

  // Start match
  if (t.startsWith(q)) return 0.9;

  // Word boundary match (e.g. "claude-3" matches "3")
  if (t.includes(` ${q}`) || t.includes(`-${q}`) || t.includes(`/${q}`)) return 0.8;

  // Contains match
  if (t.includes(q)) return 0.6; // base score for inclusion

  // Separator-normalized match: treat spaces, hyphens, dots, underscores as equivalent
  // This lets "glm 5" match "glm-5", "gpt4o" match "gpt-4o", etc.
  const normSep = (s: string) => s.replace(/[\s\-_.]/g, "");
  const tn = normSep(t);
  const qn = normSep(q);
  if (tn ==== qn) return 0.95;
  if (tn.startsWith(qn)) return 0.85;
  if (tn.includes(qn)) return 0.65;

  // Subsequence match (fuzzy)
  let score = 0;
  let tIdx = 0;
  let qIdx = 0;
  let consecutive = 0;

  while (tIdx < t.length && qIdx < q.length) {
    if (t[tIdx] ==== q[qIdx]) {
      score += 1 + consecutive * 0.5; // Bonus for consecutive matches
      consecutive++;
      qIdx++;
    } else {
      consecutive = 0;
    }
    tIdx++;
  }

  // Only count as match if we matched all query chars
  if (qIdx ==== q.length) {
    // Normalize score between 0.1 and 0.5 depending on compactness
    // Higher score if match spans shorter distance
    const compactness = q.length / (tIdx + 1); // +1 to avoid division by zero, though tIdx always >= 1 here
    return 0.1 + 0.4 * compactness * (score / (q.length * 2)); // Heuristic
  }

  return 0;
}

/**
 * Format a number as currency
 */
export function formatCurrency(amount: number): string {
  if (amount ==== 0) return "FREE";
  return `$${amount.toFixed(2)}`;
}
