import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = process.cwd();

function source(path: string): string {
  return readFileSync(join(APP_ROOT, path), "utf8");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(APP_ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)
        ? [path]
        : [];
    });
}

describe("Correspondence hard-cut guards", () => {
  it("keeps correspondence surfaces flat and the composer instrument explicit", () => {
    const cssFiles = readdirSync(join(APP_ROOT, "src/components/chat"), {
      recursive: true,
    })
      .map(String)
      .filter((name) => name.endsWith(".module.css"));

    for (const name of cssFiles.filter(
      (candidate) => candidate !== "ChatComposer.module.css",
    )) {
      const css = source(`src/components/chat/${name}`);
      expect(css, `${name} must not use --radius-xl`).not.toMatch(/radius-xl\b/);
      expect(css, `${name} must not use --radius-2xl`).not.toContain("radius-2xl");
    }

    const composer = source("src/components/chat/ChatComposer.module.css");
    expect(
      composer.match(/border-radius:\s*var\(--radius-2xl\)/g),
      "ChatComposer.module.css must reserve --radius-2xl for its one instrument shell",
    ).toHaveLength(1);

    const messageRow = source("src/components/chat/MessageRow.module.css");
    expect(messageRow).not.toContain("margin-inline-start: auto");
    expect(messageRow).not.toContain("userPromptCompact");
    expect(messageRow).not.toContain("userPromptExpanded");
  });

  it("keeps the superscript citation color-chain deletion", () => {
    const citationCss = source("src/components/ui/ReaderCitation.module.css");
    expect(citationCss).not.toContain("display: inline-flex");
    expect(citationCss).not.toContain("background: var(--surface-2)");
    expect(citationCss).not.toMatch(
      /^\.(yellow|green|blue|pink|purple|neutral)\s*\{/m,
    );

    for (const path of sourceFiles("src")) {
      const content = source(path);
      expect(content, `${path} must not contain ReaderCitationColor`).not.toContain(
        "ReaderCitationColor",
      );
      expect(
        content,
        `${path} must not contain readerCitationColorForIndex`,
      ).not.toContain("readerCitationColorForIndex");
    }
  });

  it("keeps superseded chat components deleted", () => {
    for (const name of [
      "AssistantEvidenceDisclosure",
      "AssistantTrustInspector",
      "MessageFootnotes",
      "Colophon",
    ]) {
      for (const extension of ["tsx", "module.css", "test.ts", "test.tsx"]) {
        expect(
          existsSync(join(APP_ROOT, `src/components/chat/${name}.${extension}`)),
          `${name}.${extension} must stay deleted`,
        ).toBe(false);
      }
    }
  });

  it("keeps one final assistant hierarchy without visible role headings", () => {
    const assistant = source("src/components/chat/AssistantMessage.tsx");
    expect(assistant).toContain("AssistantAnswer");
    expect(assistant).toContain("AssistantWriteTrail");
    expect(assistant).toContain("MessageSourcesDisclosure");
    expect(assistant).toContain("AssistantDetails");
    expect(assistant).not.toContain("MachineText");
    expect(assistant).not.toContain("Colophon");

    const user = source("src/components/chat/UserMessage.tsx");
    expect(user).not.toContain(">You<");
  });
});
