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

  it("keeps one semantic Nexus owner and the superseded engines deleted", () => {
    const offenders = sourceFiles(join(APP_ROOT, "src/lib/nexus")).filter(
      (path) =>
        sourceText(path).includes("@/lib/switchboard/model") ||
        sourceText(path).includes("@/components/switchboard"),
    );
    expect(offenders).toEqual([]);
    const deleted = [
      "src/lib/nexus/quickActions.ts",
      "src/lib/switchboard/model.ts",
      "src/lib/switchboard/merge.ts",
      "src/lib/switchboard/findScopes.ts",
      "src/lib/switchboard/places.ts",
      "src/lib/switchboard/performance.ts",
      "src/components/switchboard/SwitchboardRoot.tsx",
      "src/components/switchboard/SwitchboardFind.tsx",
      "src/components/switchboard/useSwitchboardController.ts",
      "src/components/nexus/desktop/DesktopNexusActionsPage.tsx",
    ];
    expect(deleted.filter((path) => existsSync(join(APP_ROOT, path)))).toEqual([]);
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
    expect(controller).toContain("parsed.text.length > 0");
    expect(controller).toContain("parsed.text.length >= 2");
  });

  it("keeps target materialization and projection ownership singular", () => {
    const nexus = sourceFiles(join(APP_ROOT, "src/lib/nexus"));
    expect(
      nexus.filter((path) =>
        /function materializeNexusTarget\s*\(/.test(sourceText(path)),
      ),
    ).toEqual(["src/lib/nexus/dispatch.ts"]);
    expect(
      nexus.filter((path) =>
        /function composeNexusProjection\s*\(/.test(sourceText(path)),
      ),
    ).toEqual(["src/lib/nexus/results.ts"]);
    expect(
      nexus.filter((path) =>
        /function dispatchNexusTarget\s*\(/.test(sourceText(path)),
      ),
    ).toEqual(["src/lib/nexus/dispatch.ts"]);
  });

  it("keeps one Nexus performance engine", () => {
    const performance = sourceText("src/lib/nexus/performance.ts");
    expect(performance).not.toMatch(/NexusDesktop|NEXUS_DESKTOP/);
    expect(
      sourceFiles(join(APP_ROOT, "src")).filter((path) =>
        sourceText(path).includes("@/lib/switchboard/performance"),
      ),
    ).toEqual([]);
  });

  it("keeps direct and recovery Manage Tabs in the shared page owner", () => {
    const controller = sourceText(
      "src/components/nexus/useNexusController.ts",
    );
    const nexus = sourceText("src/components/nexus/Nexus.tsx");
    expect(controller).toContain(
      'setPage({ kind: "ManageTabs", origin: { kind: "Direct" } });',
    );
    expect(controller).toContain(
      'page.kind === "ManageTabs" && page.origin.kind === "Recovery"',
    );
    expect(nexus).toContain("<ManageTabsPage");
  });

  it("uses deterministic code-unit tie-breaking and explicit targets", () => {
    const ranking = sourceText("src/lib/nexus/ranking.ts");
    const model = sourceText("src/lib/nexus/model.ts");
    expect(ranking).not.toContain("localeCompare");
    expect(model).not.toContain("RunCommand");
  });
});
