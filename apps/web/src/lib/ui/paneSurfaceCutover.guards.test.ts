import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = process.cwd();
const REPO_ROOT = join(APP_ROOT, "../..");
const sectionCard = ["Section", "Card"].join("");
const appList = ["App", "List"].join("");
const appListItem = `${appList}Item`;
const contextRow = ["Context", "Row"].join("");
const settingRow = ["Setting", "Row"].join("");
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
      `src/components/settings/${settingRow}.tsx`,
      `src/components/settings/${settingRow}.module.css`,
    ];

    expect(
      deleted.filter((path) => existsSync(join(APP_ROOT, path))),
    ).toEqual([]);
  });

  it("keeps app and component source off legacy row primitives", () => {
    const legacy = new RegExp(
      `\\b(${[sectionCard, appList, appListItem, contextRow, settingRow].join("|")})\\b`,
    );
    const offenders = sourceFiles(join(APP_ROOT, "src/app"))
      .concat(sourceFiles(join(APP_ROOT, "src/components")))
      .filter((path) => legacy.test(sourceText(path)));

    expect(offenders).toEqual([]);
  });

  it("keeps scoped standard pane bodies on a pane surface", () => {
    // A standard pane renders through PaneSurface directly, or through
    // CollectionView (which owns PaneSurface) — never bespoke layout.
    const offenders = standardPaneBodies.filter((path) => {
      const text = sourceText(path);
      const usesPaneSurface =
        text.includes('from "@/components/ui/PaneSurface"') && text.includes("<PaneSurface");
      const usesCollectionView =
        text.includes('from "@/components/collections/CollectionView"') &&
        text.includes("<CollectionView");
      return !usesPaneSurface && !usesCollectionView;
    });

    expect(offenders).toEqual([]);
  });

  it("keeps Browse off div-button rows and migrated list class hooks", () => {
    const browsePane = sourceText("src/app/(authenticated)/browse/BrowsePaneBody.tsx");
    expect(browsePane).toContain("useOptimisticAction");
    expect(browsePane).not.toContain("useStringIdSet");

    expect(sourceText("src/lib/collections/useCollectionDisplayState.ts")).toContain(
      "usePaneUrlState",
    );
    expect(sourceText("src/app/(authenticated)/authors/AuthorsPaneBody.tsx")).toContain(
      "useDebouncedValue",
    );

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
      /from\s+["']@\/(app|components\/workspace|lib\/(api|collections|conversations|libraries|media|notes|panes|resources|search|workspace))/;
    const offenders = [
      "src/components/ui/PaneSurface.tsx",
      "src/components/ui/PaneSection.tsx",
      "src/components/ui/ResourceList.tsx",
      "src/components/ui/ResourceRow.tsx",
    ].filter((path) => forbiddenImport.test(sourceText(path)));

    expect(offenders).toEqual([]);
  });

  it("keeps direct resource rows and lists behind CollectionView", () => {
    const allowed = new Set([
      "src/components/collections/CollectionRow.tsx",
      "src/components/collections/CollectionView.tsx",
      "src/components/sortable/SortableList.tsx",
      "src/lib/collections/types.ts",
    ]);
    const directResourcePrimitive =
      /(<Resource(?:Row|List)\b|from\s+["']@\/components\/ui\/Resource(?:Row|List)["'])/;

    const offenders = sourceFiles(join(APP_ROOT, "src/app"))
      .concat(sourceFiles(join(APP_ROOT, "src/components")))
      .concat(sourceFiles(join(APP_ROOT, "src/lib")))
      .filter((path) => !allowed.has(path))
      .filter((path) => directResourcePrimitive.test(sourceText(path)));

    expect(offenders).toEqual([]);

    const sortableList = sourceText("src/components/sortable/SortableList.tsx");
    expect(sortableList).toContain('from "@/components/ui/ResourceList"');
    expect(sortableList).toContain("resourceList ? (");
  });

  it("keeps collection presenters pure and status projection centralized", () => {
    const presenterImpurity =
      /from\s+["']react["']|\buse(?:State|Effect|Memo|Callback|Ref|Reducer|LayoutEffect)\b|\bJSX\./;
    const impurePresenters = sourceFiles(join(APP_ROOT, "src/lib/collections/presenters")).filter(
      (path) => presenterImpurity.test(sourceText(path)),
    );

    expect(impurePresenters).toEqual([]);
    const clientHookImports = sourceFiles(join(APP_ROOT, "src/lib/collections/presenters")).filter(
      (path) => sourceText(path).includes("@/lib/collections/useConnectionSummaries"),
    );
    expect(clientHookImports).toEqual([]);

    const retiredStatusSymbols =
      /\b(?:mediaStatus|syncBadge|typeBadge|MEDIA_KIND_ICONS)\b/;
    const statusOffenders = sourceFiles(join(APP_ROOT, "src/app"))
      .concat(sourceFiles(join(APP_ROOT, "src/components")))
      .concat(sourceFiles(join(APP_ROOT, "src/lib")))
      .filter((path) => retiredStatusSymbols.test(sourceText(path)));

    expect(statusOffenders).toEqual([]);
  });

  it("keeps swipe and connection-list policy explicit", () => {
    const collectionRow = sourceText("src/components/collections/CollectionRow.tsx");
    expect(collectionRow).toContain("row.swipeActions");
    expect(collectionRow).not.toContain("action.tone === \"danger\"");

    const connectionSummaries = readFileSync(
      join(
        REPO_ROOT,
        "python/nexus/services/resource_graph/connection_summaries.py",
      ),
      "utf8",
    );
    expect(connectionSummaries).toContain("LIST_CONNECTION_ORIGINS");
    const listOriginsMatch = connectionSummaries.match(
      /LIST_CONNECTION_ORIGINS: tuple\[EdgeOrigin, \.\.\.\] = \(([\s\S]*?)\)/,
    );
    expect(listOriginsMatch?.[1]).toBeDefined();
    expect(listOriginsMatch?.[1]).not.toContain('"synapse"');
    expect(listOriginsMatch?.[1]).not.toContain('"system"');
  });

  it("keeps View Transition ownership scoped and reduced-motion guarded", () => {
    const allowed = new Set([
      "src/app/(authenticated)/media/[id]/MediaPaneBody.tsx",
      "src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx",
      "src/app/globals.css",
      "src/components/collections/CollectionGalleryCard.tsx",
      "src/components/collections/CollectionRow.tsx",
      "src/components/collections/CollectionView.tsx",
      "src/components/ui/ResourceActivation.tsx",
      "src/components/ui/ResourceThumb.tsx",
      "src/components/ui/ResourceRow.tsx",
      "src/lib/collections/presenters/episode.ts",
      "src/lib/collections/presenters/media.ts",
      "src/lib/collections/presenters/search.ts",
      "src/lib/collections/useCollectionDisplayState.ts",
      "src/lib/panes/paneLinkNavigation.ts",
      "src/lib/panes/paneRuntime.tsx",
      "src/lib/ui/viewTransitions.ts",
    ]);
    const transitionPattern =
      /viewTransitionName|view-transition-name|startViewTransition|data-view-transition/;
    const offenders = sourceFiles(join(APP_ROOT, "src"))
      .filter((path) => !allowed.has(path))
      .filter((path) => transitionPattern.test(sourceText(path)));

    expect(offenders).toEqual([]);

    const globals = sourceText("src/app/globals.css");
    expect(globals).toContain("::view-transition-group(*)");
    expect(globals).toContain("::view-transition-old(*)");
    expect(globals).toContain("::view-transition-new(*)");
    expect(globals).toContain("prefers-reduced-motion: reduce");

    const mediaPane = sourceText("src/app/(authenticated)/media/[id]/MediaPaneBody.tsx");
    expect(mediaPane).toContain("readerTransitionHeader");
    expect(mediaPane).toContain("mediaReaderViewTransition.thumbName");
    expect(mediaPane).toContain("mediaReaderViewTransition.titleName");
    expect(mediaPane).not.toContain(
      "viewTransitionName: mediaReaderViewTransition.thumbName",
    );
    expect(sourceText("src/components/workspace/PaneShell.tsx")).not.toContain(
      "useMediaReaderViewTransition",
    );
  });
});
