import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Static source gates for the universal-launcher hard cutover (spec §14). These run in
// the node unit project and grep the tree so the cutover's invariants can't silently rot:
// the palette/tray surfaces stay deleted, every open routes through the one dispatch owner,
// the search lane keeps the full SearchQuery, and nav destinations have a single registry.
const APP_ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return [];
      return [relative(APP_ROOT, path).split(sep).join("/")];
    })
    .sort();
}

function sourceText(path: string): string {
  return readFileSync(join(APP_ROOT, path), "utf8");
}

const appAndComponentAndLib = (): string[] =>
  sourceFiles(join(APP_ROOT, "src/app"))
    .concat(sourceFiles(join(APP_ROOT, "src/components")))
    .concat(sourceFiles(join(APP_ROOT, "src/lib")));

describe("universal launcher cutover source gates (§14)", () => {
  it("keeps the legacy palette + add-content-tray surfaces deleted", () => {
    const deleted = [
      "src/components/palette",
      "src/components/CommandPalette.tsx",
      "src/components/AddContentTray.tsx",
      "src/components/AddContentTray.module.css",
      "src/components/QuickNotePanel.tsx",
      "src/components/commandPaletteEvents.ts",
      "src/components/addContentEvents.ts",
    ];
    expect(deleted.filter((path) => existsSync(join(APP_ROOT, path)))).toEqual([]);
  });

  it("removes every legacy palette/tray identifier from source", () => {
    const banned = new RegExp(
      [
        "usePaletteController",
        "paletteModel",
        "paletteProviders",
        "paletteRanking",
        "paletteActions",
        "paletteIntent",
        "parsePaletteInput",
        "PaletteItem",
        "PaletteTarget",
        "OPEN_ADD_CONTENT_EVENT",
        "OPEN_COMMAND_PALETTE_EVENT",
        "AddContentTray",
        "QuickNotePanel",
        "commandPaletteEvents",
        "addContentEvents",
        "dispatchOpenAddContent",
      ].join("|"),
    );
    expect(appAndComponentAndLib().filter((path) => banned.test(sourceText(path)))).toEqual([]);
  });

  it("uses the open-launcher keybinding id, never open-palette", () => {
    expect(appAndComponentAndLib().filter((path) => sourceText(path).includes("open-palette"))).toEqual(
      [],
    );
  });

  it("routes every launcher open through dispatch.ts — one opener (AC-9)", () => {
    // dispatch.ts lives in lib/launcher/, so NOTHING under components/launcher/ may open a pane.
    const opensPane = /\b(?:requestOpenInAppPane|activateResource)\s*\(|window\.location\.assign\s*\(/;
    const offenders = sourceFiles(join(APP_ROOT, "src/components/launcher")).filter((path) =>
      opensPane.test(sourceText(path)),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the search lane on the full SearchQuery — no all-types limit:5 fetch", () => {
    const offenders = sourceFiles(join(APP_ROOT, "src/components/launcher"))
      .concat(sourceFiles(join(APP_ROOT, "src/lib/launcher")))
      .filter((path) => /fetchSearchResultPage\([^)]*limit:\s*5\b/.test(sourceText(path)));
    expect(offenders).toEqual([]);
  });

  it("derives nav destinations from one registry — no href literal in both navModel and launcher providers (AC-8)", () => {
    const navModel = sourceText("src/components/appnav/navModel.ts");
    const providers = sourceText("src/lib/launcher/providers.ts");
    const hrefs = [
      "/libraries",
      "/authors",
      "/podcasts",
      "/notes",
      "/daily",
      "/conversations",
      "/settings",
      "/oracle",
      "/search",
    ];
    const inBoth = hrefs.filter(
      (href) => navModel.includes(`"${href}"`) && providers.includes(`"${href}"`),
    );
    expect(inBoth).toEqual([]);
  });
});
