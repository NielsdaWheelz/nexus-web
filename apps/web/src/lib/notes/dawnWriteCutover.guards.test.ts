import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Negative gates for the Dawn Write hard cutover (dawn-write-hard-cutover.md
// §13 frontend gates 5–7). Node `.test.ts` (unit project), cwd = apps/web.

const APP_ROOT = process.cwd();

function sourceText(path: string): string {
  return readFileSync(join(APP_ROOT, path), "utf8");
}

const DAWN_WRITE_BLOCK = "src/components/notes/DawnWriteBlock.tsx";

describe("Dawn Write cutover source gates", () => {
  // §13 gate 5 — DawnWriteBlock must import MachineText.
  it("DawnWriteBlock imports MachineText (machine register gate)", () => {
    const source = sourceText(DAWN_WRITE_BLOCK);
    expect(source).toMatch(/from\s+["']@\/components\/ui\/MachineText["']/);
  });

  // §13 gate 6 — dismiss button is outside the MachineText wrapper (control-bleed rule).
  // Source-level check: the <button aria-label="Dismiss dawn write"> must not appear
  // nested inside the <MachineText ...> opening tag's JSX scope.
  it("dismiss button is outside the MachineText JSX scope (control-bleed)", () => {
    const source = sourceText(DAWN_WRITE_BLOCK);
    const machineOpen = source.indexOf("<MachineText");
    const machineClose = source.indexOf("</MachineText>");
    const buttonPos = source.indexOf('"Dismiss dawn write"');
    // The button aria-label must appear AFTER </MachineText>, not inside it.
    expect(machineOpen).toBeGreaterThan(-1);
    expect(machineClose).toBeGreaterThan(machineOpen);
    expect(buttonPos).toBeGreaterThan(machineClose);
  });

  // §13 gate 7 — DawnWriteBlock checks dismissed_at in its render guard so
  // dismissed writes never re-render the block.
  it("DawnWriteBlock guards against dismissed writes in its render path", () => {
    const source = sourceText(DAWN_WRITE_BLOCK);
    // Either the useState init reads dismissed_at or there's an explicit guard.
    expect(source).toMatch(/dismissed_at/);
    // The dismissal state must be checked before rendering MachineText.
    const dismissedCheck = source.indexOf("dismissed_at");
    const machineOpen = source.indexOf("<MachineText");
    expect(dismissedCheck).toBeLessThan(machineOpen);
  });
});
