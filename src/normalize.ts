/**
 * Normalize a text snippet for deterministic comparison.
 *
 * Rules, in order:
 * 1. Unicode NFC normalization.
 * 2. Fold smart quotes and typographic apostrophes to ASCII straight quotes / apostrophe.
 * 3. Remove zero-width characters (U+200B, U+200C, U+200D, U+FEFF) and non-breaking spaces (U+00A0).
 * 4. Collapse runs of whitespace to a single ASCII space.
 * 5. Trim leading and trailing whitespace.
 */
export function normalizeSnippet(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
