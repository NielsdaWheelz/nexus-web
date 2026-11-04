// One drawing, one export. Checked by value, not by name: lucide exports each drawing
// under several names (`X`, `XIcon`, `LucideX`), so only identity sees an alias.
import * as Icon from "../src/lib/ui/icons";

const seen = new Map<unknown, string>();
for (const [name, glyph] of Object.entries(Icon)) {
  if (seen.has(glyph)) throw new Error(`${name} and ${seen.get(glyph)} are one drawing`);
  seen.set(glyph, name);
}
