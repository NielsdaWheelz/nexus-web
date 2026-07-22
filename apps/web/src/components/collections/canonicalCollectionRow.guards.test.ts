import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = process.cwd();
const collectionCallers = [
  "src/app/(authenticated)/search/SearchPaneBody.tsx",
  "src/app/(authenticated)/libraries/LibrariesPaneBody.tsx",
  "src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx",
  "src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx",
  "src/app/(authenticated)/podcasts/[podcastId]/PodcastEpisodeList.tsx",
  "src/app/(authenticated)/notes/NotesPaneBody.tsx",
  "src/app/(authenticated)/conversations/ConversationsPaneBody.tsx",
  "src/app/(authenticated)/lectern/LecternPaneBody.tsx",
  "src/components/collections/ReadingSlateSection.tsx",
  "src/app/(authenticated)/settings/SettingsPaneBody.tsx",
  "src/app/(authenticated)/settings/identities/PasswordRow.tsx",
  "src/app/(authenticated)/settings/identities/SettingsIdentitiesPaneBody.tsx",
  "src/app/(authenticated)/settings/keybindings/KeybindingsPaneBody.tsx",
  "src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx",
] as const;

const scopedCallerPresentationFiles = [
  ...collectionCallers,
  "src/app/(authenticated)/authors/[handle]/page.module.css",
  "src/app/(authenticated)/lectern/LecternPaneBody.module.css",
  "src/app/(authenticated)/podcasts/[podcastId]/page.module.css",
  "src/app/(authenticated)/search/page.module.css",
  "src/app/(authenticated)/libraries/[id]/LibraryPaneBody.ac4.test.tsx",
  "src/app/(authenticated)/libraries/[id]/LibraryPaneBody.readingSlate.test.tsx",
  "src/components/collections/CollectionRow.module.css",
  "src/components/sortable/SortableList.module.css",
] as const;

function source(path: string): string {
  return readFileSync(join(APP_ROOT, path), "utf8");
}

describe("canonical collection row source gates", () => {
  it("keeps pointer reorder on the exact mouse and touch thresholds", () => {
    const sortable = source("src/components/sortable/SortableList.tsx");

    expect(sortable).toMatch(
      /useSensor\(MouseSensor,\s*\{\s*activationConstraint: \{ distance: 8 \}/,
    );
    expect(sortable).toMatch(
      /useSensor\(TouchSensor,\s*\{\s*activationConstraint: \{ delay: 250, tolerance: 8 \}/,
    );
    expect(sortable).not.toContain("PointerSensor");
    expect(sortable).not.toContain("KeyboardSensor");
  });

  it("keeps the canonical supporting line on normal leading", () => {
    const rowCss = source("src/components/ui/ResourceRow.module.css");
    const supportingRule = rowCss.match(/\.supporting\s*\{([^}]*)\}/)?.[1];

    expect(supportingRule).toContain("line-height: var(--leading-normal)");
  });

  it("keeps the canonical owners free of alternate row modes and chrome", () => {
    const owners = [
      "src/components/collections/CollectionView.tsx",
      "src/components/collections/CollectionRow.tsx",
      "src/components/ui/ResourceList.tsx",
      "src/components/ui/ResourceRow.tsx",
    ].map(source).join("\n");
    const css = [
      "src/components/collections/CollectionRow.module.css",
      "src/components/ui/ResourceList.module.css",
      "src/components/ui/ResourceRow.module.css",
    ].map(source).join("\n");

    for (const stale of [
      "CollectionGalleryCard",
      "ReadStateBadge",
      "ResourceThumb",
      "role=\"progressbar\"",
      "renderControls",
      "rowActionsVisibility",
      "swipeActions",
    ]) {
      expect(owners).not.toContain(stale);
    }
    expect(css).not.toMatch(/\[data-(?:view|density)/);
  });

  it("routes every named collection caller through mode-free CollectionView", () => {
    for (const path of collectionCallers) {
      const text = source(path);
      const collectionViews = text.match(/<CollectionView\b[\s\S]*?\/>/g) ?? [];
      expect(collectionViews.length, path).toBeGreaterThan(0);
      for (const invocation of collectionViews) {
        expect(invocation, path).not.toMatch(
          /\b(?:view|density|rowActionsVisibility)=/,
        );
      }
    }
  });

  it("keeps scoped callers, CSS, and acceptance tests free of retired modes", () => {
    const retiredMode =
      /CollectionGalleryCard|data-(?:view|density)|\b(?:view|density)=["'{]|["']gallery["']|\bGallery\b/;
    const offenders = scopedCallerPresentationFiles.filter((path) =>
      retiredMode.test(source(path)),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps the full named caller path free of row imagery and duplicate status chrome", () => {
    const forbiddenChrome =
      /<img\b|<ResourceThumb\b|ReadStateBadge|ReadyBadge|mediaProcessingStatusPill|role=["']progressbar["']/;
    const offenders = collectionCallers.filter((path) =>
      forbiddenChrome.test(source(path)),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps presenters and callers from href-ID parsing or related hydration", () => {
    const presenterPaths = [
      "src/lib/collections/presenters/conversation.ts",
      "src/lib/collections/presenters/episode.ts",
      "src/lib/collections/presenters/lectern.ts",
      "src/lib/collections/presenters/library.ts",
      "src/lib/collections/presenters/media.ts",
      "src/lib/collections/presenters/note.ts",
      "src/lib/collections/presenters/podcast.ts",
      "src/lib/collections/presenters/presentContributorWork.ts",
      "src/lib/collections/presenters/search.ts",
      "src/lib/collections/presenters/settings.ts",
      "src/lib/resonance/presentSlateItem.ts",
    ];
    const scoped = [...collectionCallers, ...presenterPaths];

    for (const path of scoped) {
      const text = source(path);
      expect(text, path).not.toMatch(/useRelatedMedia|queryRelatedMedia/);
      expect(text, path).not.toMatch(
        /href\s*\.(?:split|match)|new URL\([^)]*href/,
      );
    }
  });

  it("keeps reorder hosts free of separate handle controls", () => {
    for (const path of [
      "src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx",
      "src/app/(authenticated)/lectern/LecternPaneBody.tsx",
    ]) {
      expect(source(path), path).not.toMatch(
        /renderControls|SortableHandle|DragHandle|aria-label=\{?`?Reorder/,
      );
    }
  });
});
