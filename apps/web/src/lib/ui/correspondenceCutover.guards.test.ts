import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Negative gates for the Correspondence hard cutover
// (correspondence-hard-cutover.md §13).
// Pattern: readFileSync-over-source, node unit project.

const APP_ROOT = process.cwd();

function src(path: string): string {
  return readFileSync(join(APP_ROOT, path), "utf8");
}

describe("Correspondence cutover source gates", () => {
  // §13-1 — No --radius-2xl in chat/composer surfaces.
  it("Gate 1: ChatComposer.module.css and MessageRow.module.css contain no --radius-2xl", () => {
    const composer = src("src/components/chat/ChatComposer.module.css");
    expect(composer).not.toContain("radius-2xl");

    const messageRow = src("src/components/chat/MessageRow.module.css");
    expect(messageRow).not.toContain("radius-2xl");
  });

  // AC-1/G7 — No chat-surface element has border-radius > --radius-lg.
  // The two radius tokens above lg are --radius-xl and --radius-2xl. Scanned
  // recursively so a new chat CSS file can't reintroduce a card-blob radius
  // (the narrow Gate-1 file list would miss it — e.g. ModelSettingsPopover).
  it("Gate 1b: no .module.css under components/chat references --radius-xl or --radius-2xl", () => {
    const chatDir = join(APP_ROOT, "src/components/chat");
    const cssFiles = readdirSync(chatDir, { recursive: true })
      .map((entry) => String(entry))
      .filter((name) => name.endsWith(".module.css"));
    for (const name of cssFiles) {
      const css = readFileSync(join(chatDir, name), "utf8");
      expect(css, `${name} must not use --radius-xl`).not.toMatch(/radius-xl\b/);
      expect(css, `${name} must not use --radius-2xl`).not.toContain("radius-2xl");
    }
  });

  // §13-2 — No right-aligned user prompt.
  it("Gate 2: MessageRow.module.css contains no userPromptCompact, userPromptExpanded, or margin-inline-start: auto", () => {
    const messageRow = src("src/components/chat/MessageRow.module.css");
    expect(messageRow).not.toContain("userPromptCompact");
    expect(messageRow).not.toContain("userPromptExpanded");
    expect(messageRow).not.toContain("margin-inline-start: auto");
  });

  it("Gate 2b: No TSX file under components/chat references userPromptCompact or userPromptExpanded", () => {
    const files = [
      "src/components/chat/UserMessage.tsx",
      "src/components/chat/MessageRow.tsx",
      "src/components/chat/AssistantMessage.tsx",
      "src/components/chat/ChatComposer.tsx",
    ];
    for (const file of files) {
      const content = src(file);
      expect(content, `${file} must not reference userPromptCompact`).not.toContain(
        "userPromptCompact",
      );
      expect(content, `${file} must not reference userPromptExpanded`).not.toContain(
        "userPromptExpanded",
      );
    }
  });

  // §13-3 — Citation chip CSS and TS color chain deleted.
  it("Gate 3: ReaderCitation.module.css has no display: inline-flex or background: var(--surface-2) in .citation", () => {
    const css = src("src/components/ui/ReaderCitation.module.css");
    expect(css).not.toContain("display: inline-flex");
    expect(css).not.toContain("background: var(--surface-2)");
  });

  it("Gate 3b: ReaderCitation.module.css has no color-variant classes (.yellow, .green, .blue, .pink, .purple, .neutral)", () => {
    const css = src("src/components/ui/ReaderCitation.module.css");
    expect(css).not.toMatch(/^\.yellow\s*\{/m);
    expect(css).not.toMatch(/^\.green\s*\{/m);
    expect(css).not.toMatch(/^\.blue\s*\{/m);
    expect(css).not.toMatch(/^\.pink\s*\{/m);
    expect(css).not.toMatch(/^\.purple\s*\{/m);
    expect(css).not.toMatch(/^\.neutral\s*\{/m);
  });

  it("Gate 3c: colorClass, ReaderCitationColor, readerCitationColorForIndex are absent from non-test source files", () => {
    const nonTestSources = [
      "src/lib/conversations/readerCitation.ts",
      "src/lib/resourceGraph/citations.ts",
      "src/components/ui/ReaderCitation.tsx",
      "src/components/ui/MarkdownMessage.tsx",
      "src/components/chat/AssistantEvidenceDisclosure.tsx",
      "src/components/chat/AssistantMessage.tsx",
    ];
    for (const file of nonTestSources) {
      const content = src(file);
      expect(content, `${file} must not contain colorClass`).not.toContain("colorClass");
      expect(content, `${file} must not contain ReaderCitationColor`).not.toContain(
        "ReaderCitationColor",
      );
      expect(content, `${file} must not contain readerCitationColorForIndex`).not.toContain(
        "readerCitationColorForIndex",
      );
    }
  });

  // §13-4 — Colophon is the sole owner of formatting helpers.
  it("Gate 4: formatColophonTokens, formatColophonCost, formatColophonModel are defined only in Colophon.tsx", () => {
    const colophon = src("src/components/chat/Colophon.tsx");
    expect(colophon).toContain("formatColophonTokens");
    expect(colophon).toContain("formatColophonCost");
    expect(colophon).toContain("formatColophonModel");

    // No other non-test file re-implements them.
    const otherFiles = [
      "src/components/chat/AssistantMessage.tsx",
      "src/components/chat/MessageFootnotes.tsx",
      "src/components/chat/MessageRow.tsx",
    ];
    for (const file of otherFiles) {
      const content = src(file);
      expect(content, `${file} must not define formatColophonTokens`).not.toContain(
        "function formatColophonTokens",
      );
      expect(content, `${file} must not define formatColophonCost`).not.toContain(
        "function formatColophonCost",
      );
      expect(content, `${file} must not define formatColophonModel`).not.toContain(
        "function formatColophonModel",
      );
    }
  });

  // §13-5 — userPromptPresentation is dead.
  it("Gate 5: userPromptPresentation is absent from all source files", () => {
    const files = [
      "src/components/chat/UserMessage.tsx",
      "src/components/chat/MessageRow.tsx",
      "src/components/chat/AssistantMessage.tsx",
    ];
    for (const file of files) {
      const content = src(file);
      expect(content, `${file} must not contain userPromptPresentation`).not.toContain(
        "userPromptPresentation",
      );
    }
  });

  // §13-6 — MessageFootnotes is the sole owner of aria-label="Sources".
  it('Gate 6: aria-label="Sources" appears only in MessageFootnotes.tsx', () => {
    const footnotes = src("src/components/chat/MessageFootnotes.tsx");
    expect(footnotes).toContain('aria-label="Sources"');

    // Ensure no other chat component declares this label.
    const otherChatFiles = [
      "src/components/chat/AssistantMessage.tsx",
      "src/components/chat/AssistantEvidenceDisclosure.tsx",
      "src/components/chat/AssistantTrustInspector.tsx",
    ];
    for (const file of otherChatFiles) {
      const content = src(file);
      expect(content, `${file} must not have aria-label="Sources"`).not.toContain(
        'aria-label="Sources"',
      );
    }
  });
});
