import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = process.cwd();
const sectionCard = ["Section", "Card"].join("");
const appList = ["App", "List"].join("");
const appListItem = `${appList}Item`;
const contextRow = ["Context", "Row"].join("");
const standardPaneBodies = [
  "src/app/(authenticated)/authors/AuthorsPaneBody.tsx",
  "src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx",
  "src/app/(authenticated)/browse/BrowsePaneBody.tsx",
  "src/app/(authenticated)/conversations/ConversationsPaneBody.tsx",
  "src/app/(authenticated)/libraries/LibrariesPaneBody.tsx",
  "src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx",
  "src/app/(authenticated)/notes/NotesPaneBody.tsx",
  "src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx",
  "src/app/(authenticated)/search/SearchPaneBody.tsx",
  "src/app/(authenticated)/settings/SettingsPaneBody.tsx",
  "src/app/(authenticated)/settings/account/SettingsAccountPaneBody.tsx",
  "src/app/(authenticated)/settings/appearance/SettingsAppearancePaneBody.tsx",
  "src/app/(authenticated)/settings/billing/SettingsBillingPaneBody.tsx",
  "src/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody.tsx",
  "src/app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx",
  "src/app/(authenticated)/settings/keys/SettingsKeysPaneBody.tsx",
  "src/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody.tsx",
  "src/app/(authenticated)/settings/reader/SettingsReaderPaneBody.tsx",
];

function sourceFiles(dir: string): string[] {
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

describe("pane surface/resource row cutover source gates", () => {
  it("keeps the legacy public primitives deleted", () => {
    const deleted = [
      `src/components/ui/${sectionCard}.tsx`,
      `src/components/ui/${sectionCard}.module.css`,
      `src/components/ui/${appList}.tsx`,
      `src/components/ui/${appList}.module.css`,
      `src/components/ui/${contextRow}.tsx`,
      `src/components/ui/${contextRow}.module.css`,
    ];

    expect(
      deleted.filter((path) => existsSync(join(APP_ROOT, path))),
    ).toEqual([]);
  });

  it("keeps app and component source off legacy row primitives", () => {
    const legacy = new RegExp(
      `\\b(${[sectionCard, appList, appListItem, contextRow].join("|")})\\b`,
    );
    const offenders = sourceFiles(join(APP_ROOT, "src/app"))
      .concat(sourceFiles(join(APP_ROOT, "src/components")))
      .filter((path) => legacy.test(sourceText(path)));

    expect(offenders).toEqual([]);
  });

  it("keeps scoped standard pane bodies on PaneSurface", () => {
    const offenders = standardPaneBodies.filter((path) => {
      const text = sourceText(path);
      return (
        !text.includes('from "@/components/ui/PaneSurface"') ||
        !text.includes("<PaneSurface")
      );
    });

    expect(offenders).toEqual([]);
  });

  it("keeps Browse off div-button rows and migrated list class hooks", () => {
    const offenders = sourceFiles(join(APP_ROOT, "src/app/(authenticated)/browse"))
      .filter((path) => sourceText(path).includes('role="button"'));

    expect(offenders).toEqual([]);

    const migratedClassOffenders = sourceFiles(join(APP_ROOT, "src/app")).filter(
      (path) => {
        const text = sourceText(path);
        return text.includes("styles.resultRows") || text.includes("styles.pageList");
      },
    );

    expect(migratedClassOffenders).toEqual([]);
  });

  it("keeps new primitives below pane runtime and domain layers", () => {
    const forbiddenImport =
      /from\s+["']@\/(app|components\/workspace|lib\/(api|conversations|libraries|media|notes|panes|resources|search|workspace))/;
    const offenders = [
      "src/components/ui/PaneSurface.tsx",
      "src/components/ui/PaneSection.tsx",
      "src/components/ui/ResourceList.tsx",
      "src/components/ui/ResourceRow.tsx",
    ].filter((path) => forbiddenImport.test(sourceText(path)));

    expect(offenders).toEqual([]);
  });
});
