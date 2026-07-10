import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Negative gates for the Machine Hand hard cutover (machine-hand-hard-cutover.md
// §13). Modeled on the readFileSync-over-source pattern in
// paneSurfaceCutover.guards.test.ts + the globals.css-reading firstPaintCutover
// gate: because the machine register is CSS (not an import) and the owner
// boundary is a CSS module, the enforced gate is a vitest source-grep — the house
// FE negative-gate form. Node `.test.ts` (unit project), cwd = apps/web.

const APP_ROOT = process.cwd();
const OWNER_MODULE_CSS = "src/components/ui/MachineText.module.css";
const MACHINE_TOKENS = ["--font-machine", "--ink-machine", "--rail-machine"];
const MARKDOWN_IMPORTERS = [
  "src/components/chat/AssistantEvidenceDisclosure.tsx",
  "src/components/chat/ConversationDistillate.tsx",
  "src/components/library/LibraryBriefArtifact.tsx",
  "src/components/notes/DawnWriteBlock.tsx",
];

function sourceText(path: string): string {
  return readFileSync(join(APP_ROOT, path), "utf8");
}

function filesUnder(dir: string, match: (name: string) => boolean): string[] {
  return readdirSync(join(APP_ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return filesUnder(rel, match);
      return match(entry.name) ? [rel] : [];
    })
    .sort();
}

const isModuleCss = (name: string) => name.endsWith(".module.css");
const isNonTestSource = (name: string) =>
  /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name);

// The `.selector { ... }` declaration block for a class in a CSS module.
function cssRuleBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("Machine Hand cutover source gates", () => {
  // §13.1 — the machine tokens live in exactly one module CSS.
  it("keeps the machine tokens owned by MachineText.module.css alone", () => {
    const offenders = filesUnder("src", isModuleCss)
      .filter((path) => path !== OWNER_MODULE_CSS)
      .filter((path) =>
        MACHINE_TOKENS.some((token) => sourceText(path).includes(token)),
      );
    expect(offenders).toEqual([]);

    // The owner really does reference them (guards against a silent rename).
    const owner = sourceText(OWNER_MODULE_CSS);
    for (const token of MACHINE_TOKENS) {
      expect(owner).toContain(`var(${token})`);
    }
  });

  // §13.2 — no inline-style bypass of the register in production TSX.
  it("keeps machine tokens out of inline styles (register only via MachineText)", () => {
    const offenders = filesUnder("src", isNonTestSource)
      .filter((path) => path.endsWith(".tsx"))
      .filter((path) =>
        MACHINE_TOKENS.some((token) => sourceText(path).includes(token)),
      );
    expect(offenders).toEqual([]);
  });

  // §13.3 — prose can't skip the register (closed-set + wrapper check).
  it("keeps MarkdownMessage importers a closed set of machine-voice sites", () => {
    const importers = filesUnder("src", isNonTestSource).filter((path) =>
      /from\s+["']@\/components\/ui\/MarkdownMessage["']/.test(sourceText(path)),
    );
    expect(importers).toEqual([...MARKDOWN_IMPORTERS].sort());

    // Each importer is a known machine-voice site.
    expect(
      sourceText("src/components/library/LibraryBriefArtifact.tsx"),
    ).toMatch(/from\s+["']@\/components\/ui\/MachineText["']/);
    expect(sourceText("src/components/chat/AssistantMessage.tsx")).toMatch(
      /from\s+["']@\/components\/ui\/MachineText["']/,
    );
    expect(sourceText("src/components/notes/DawnWriteBlock.tsx")).toMatch(
      /from\s+["']@\/components\/ui\/MachineText["']/,
    );

    // AssistantEvidenceDisclosure (which imports MarkdownMessage directly) is
    // rendered ONLY by AssistantMessage — the wrapper that owns the register.
    const evidenceImporters = filesUnder("src", isNonTestSource)
      .filter((path) => path !== "src/components/chat/AssistantEvidenceDisclosure.tsx")
      .filter((path) =>
        /from\s+["'][^"']*\/AssistantEvidenceDisclosure["']/.test(sourceText(path)),
      );
    expect(evidenceImporters).toEqual(["src/components/chat/AssistantMessage.tsx"]);
  });

  // §13.4 — the Oracle pane tree never imports MachineText (N-1).
  it("keeps MachineText out of the Oracle pane tree", () => {
    const offenders = filesUnder("src/app/(authenticated)/oracle", isNonTestSource).filter(
      (path) => sourceText(path).includes("components/ui/MachineText"),
    );
    expect(offenders).toEqual([]);
  });

  // §13.5 — the deletions stay dead; the shared .timestamp CSS survives.
  it("keeps the assistant timestamp render site and the .assistantBody ink deleted", () => {
    const assistant = sourceText("src/components/chat/AssistantMessage.tsx");
    expect(assistant).not.toContain("styles.timestamp");
    expect(assistant).not.toContain("timestampLabel");

    const messageRowCss = sourceText("src/components/chat/MessageRow.module.css");
    expect(cssRuleBlock(messageRowCss, ".assistantBody")).not.toContain("color");
    // The shared .timestamp class is deliberately kept (user/system rows).
    expect(messageRowCss).toContain(".timestamp {");

    const markdownCss = sourceText("src/components/ui/MarkdownMessage.module.css");
    expect(cssRuleBlock(markdownCss, ".markdown")).not.toContain("var(--ink)");
  });

  // §13.6 — the tokens exist once (font) / per theme (ink + rail).
  it("declares the machine tokens in every theme location", () => {
    const globals = sourceText("src/app/globals.css");
    expect(globals.match(/--font-machine:/g)).toHaveLength(1);
    expect(globals.match(/--ink-machine:/g)).toHaveLength(3);
    expect(globals.match(/--rail-machine:/g)).toHaveLength(3);

    for (const selector of [":root", '[data-theme="light"]', ":root:not([data-theme])"]) {
      const block = cssRuleBlock(globals, selector);
      expect(block).toContain("--ink-machine:");
      expect(block).toContain("--rail-machine:");
    }
  });
});
