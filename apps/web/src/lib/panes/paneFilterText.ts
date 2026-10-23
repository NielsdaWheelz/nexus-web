/** Pane/source text matching is pinned to Unicode 15, as in Python 3.12.
 * Native NFC and scalar lowercase need a Unicode-15-capable browser. Newer
 * unassigned characters stay opaque boundaries; final sigma uses frozen
 * properties because even assigned characters' casing properties can change.
 */
import { CASED_15, CASE_IGNORABLE_15, UNASSIGNED_15 } from "./paneFilterUnicode15.gen";

export function paneFilterText(value: string): string {
  const normalized = value.split(UNASSIGNED_15)
    .map((part, index) => index % 2 === 0 ? part.normalize("NFC") : part).join("");
  const characters = Array.from(normalized);
  return characters.map((character, index) => {
    if (UNASSIGNED_15.test(character)) return character;
    if (character !== "Σ") return character.toLowerCase();
    let before = index - 1;
    while (before >= 0 && CASE_IGNORABLE_15.test(characters[before])) before--;
    let after = index + 1;
    while (after < characters.length && CASE_IGNORABLE_15.test(characters[after])) after++;
    return before >= 0 && CASED_15.test(characters[before]) &&
      (after === characters.length || !CASED_15.test(characters[after])) ? "ς" : "σ";
  }).join("");
}
