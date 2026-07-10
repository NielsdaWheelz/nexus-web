import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Negative gates for the Second Apparatus hard cutover (second-apparatus-hard-
// cutover.md §13, clauses 2, 4, 6). readFileSync-over-source, the house FE
// negative-gate form. Node `.test.ts` (unit project), cwd = apps/web.

const APP_ROOT = process.cwd();

function sourceText(path: string): string {
  return readFileSync(join(APP_ROOT, path), "utf8");
}

const MACHINE_TOKENS = ["--font-machine", "--ink-machine", "--rail-machine"];

describe("Second Apparatus cutover source gates", () => {
  // §13.2 — Second Apparatus adds no origin. The amanuensis cutover (same batch)
  // adds exactly one — `assistant`, the house agent's hand — so EDGE_ORIGINS holds
  // these eight and no others.
  it("keeps EDGE_ORIGINS to the sanctioned origins (assistant is the only agent add)", () => {
    const edges = sourceText("src/lib/resourceGraph/edges.ts");
    const block = edges.slice(edges.indexOf("EDGE_ORIGINS = ["));
    const literals = block.slice(0, block.indexOf("]")).match(/"[a-z_]+"/g) ?? [];
    expect(literals).toEqual([
      '"user"',
      '"citation"',
      '"system"',
      '"note_body"',
      '"highlight_note"',
      '"synapse"',
      '"document_embed"',
      '"assistant"',
    ]);
  });

  // §13.4 — the Cite/stance composers never build or send a snapshot on a user edge.
  it("keeps snapshots out of the Cite/stance composers", () => {
    for (const path of [
      "src/lib/reader/useCiteComposer.ts",
      "src/lib/reader/useStanceComposer.ts",
    ]) {
      const src = sourceText(path);
      expect(src).not.toMatch(/CitationSnapshot/);
      expect(src).not.toMatch(/\bsnapshot\b/);
    }
  });

  // §13.6 — the machine register reaches the margin only through MachineText;
  // MarginRail.module.css never names the machine tokens.
  it("keeps machine tokens out of MarginRail.module.css and MachineText in the rail", () => {
    const css = sourceText("src/components/reader/MarginRail.module.css");
    for (const token of MACHINE_TOKENS) {
      expect(css).not.toContain(token);
    }
    const rail = sourceText("src/components/reader/MarginRail.tsx");
    expect(rail).toMatch(/from\s+["']@\/components\/ui\/MachineText["']/);
  });
});
