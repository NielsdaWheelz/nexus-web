import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      if (
        !/\.(ts|tsx)$/.test(entry.name) ||
        /\.test\.(ts|tsx)$/.test(entry.name)
      ) {
        return [];
      }
      return [relative(APP_ROOT, path).split(sep).join("/")];
    })
    .sort();
}

function sourceText(path: string): string {
  return readFileSync(join(APP_ROOT, path), "utf8");
}

describe("Nexus architecture invariants", () => {
  it("keeps the superseded runtime directories and endpoints deleted", () => {
    const oldName = ["launch", "er"].join("");
    const oldHistory = ["palette", "-history"].join("");
    const oldSelections = ["palette", "-selections"].join("");
    const deleted = [
      `src/components/${oldName}`,
      `src/lib/${oldName}`,
      `src/app/api/me/${oldHistory}`,
      `src/app/api/me/${oldSelections}`,
    ];

    expect(
      deleted.filter((path) => existsSync(join(APP_ROOT, path))),
    ).toEqual([]);
  });

  it("keeps shared Nexus independent of mobile presentation models", () => {
    const offenders = sourceFiles(join(APP_ROOT, "src/lib/nexus")).filter(
      (path) =>
        sourceText(path).includes("@/lib/switchboard/model") ||
        sourceText(path).includes("@/components/switchboard"),
    );
    expect(offenders).toEqual([]);
    expect(
      existsSync(join(APP_ROOT, "src/lib/switchboard/merge.ts")),
    ).toBe(true);
  });

  it("keeps Switchboard components presentation-only", () => {
    const forbidden =
      /\b(?:apiFetch|fetch|createNotePage|createLibrary|subscribeToPodcast|activateWorkspaceTarget|dispatchNexusTarget)\s*\(|window\.(?:location|open)\b/;
    const offenders = sourceFiles(
      join(APP_ROOT, "src/components/switchboard"),
    ).filter((path) => forbidden.test(sourceText(path)));
    expect(offenders).toEqual([]);
  });

  it("pins one-character openables and two-character owned-search thresholds", () => {
    const controller = sourceText(
      "src/components/nexus/useNexusController.ts",
    );
    expect(controller).toContain("parsedQuery.text.length > 0");
    expect(controller).toContain("parsedQuery.text.length >= 2");
  });

  it("uses deterministic code-unit tie-breaking and explicit targets", () => {
    const ranking = sourceText("src/lib/nexus/ranking.ts");
    const model = sourceText("src/lib/nexus/model.ts");
    expect(ranking).not.toContain("localeCompare");
    expect(model).not.toContain("RunCommand");
  });
});
