import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PanePrimaryChromeProvider } from "@/components/workspace/PanePrimaryChrome";
import PaneSearchBar from "@/components/workspace/PaneSearchBar";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import type { PanePrimaryChromePublication } from "@/lib/panes/panePublications";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
} from "@/lib/workspace/paneReturnMemento";
import LecternPaneBody from "./LecternPaneBody";

/**
 * Oracle: `docs/cutovers/collection-refinement-capability-hard-cutover.md`
 * (Target Behavior 1–11, Acceptance 2/6/7/8/9). Lectern is the one surface
 * whose refinement runs entirely on the client, so these proofs cover the
 * risks that only exist there: a view sort that silently rewrites the authored
 * order through `SetOrder`, a drag affordance that survives a filtered or
 * sorted view (the server rejects anything but the exact visible permutation),
 * and a folio that starts describing the local subset.
 */

const SHOW_TITLE = "The Signal Room";
const RUMOR = "Anatomy of a Rumor";
const DRIFT = "Meridian Drift";
const PARADOX = "Zeno’s Paradox";
const TITLES = [RUMOR, DRIFT, PARADOX];

const NOOP = () => undefined;
const ACTIVATE_TARGET = () => ({
  kind: "ActivatedExisting" as const,
  paneId: "pane",
});

function footerAudio() {
  return {
    kind: "FooterAudio",
    streamUrl: "/api/media/stream",
    sourceUrl: "https://example.test/episode.mp3",
    positionMs: 0,
    writeRevision: 1,
    resetEpoch: 0,
    playbackRate: {
      value: 1,
      source: "Product",
      podcastPreference: { kind: "Absent" },
    },
    pauseShorteningMode: { kind: "Absent" },
    consumptionOverrideRevision: { kind: "Absent" },
    durationMs: { kind: "Present", value: 1_800_000 },
    artworkUrl: { kind: "Absent" },
    chapters: [],
  };
}

function wireItem(input: {
  readonly itemId: string;
  readonly mediaId: string;
  readonly kind: string;
  readonly title: string;
  readonly subtitle: { kind: "Absent" } | { kind: "Present"; value: string };
  readonly addedAt: string;
  readonly activation: Record<string, unknown>;
}) {
  return {
    itemId: input.itemId,
    mediaId: input.mediaId,
    kind: input.kind,
    title: input.title,
    subtitle: input.subtitle,
    href: `/media/${input.mediaId}`,
    addedAt: input.addedAt,
    consumption: {
      state: "Unread",
      progress: { kind: "Absent" },
      progressResettable: false,
    },
    activation: input.activation,
  };
}

// Authored (Custom) order is deliberately neither the Added nor the Title
// order, so every ordering assertion distinguishes all three.
const SNAPSHOT_ITEMS = [
  wireItem({
    itemId: "11111111-1111-4111-8111-111111111111",
    mediaId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    kind: "epub",
    title: PARADOX,
    subtitle: { kind: "Absent" },
    addedAt: "2026-01-05T09:00:00Z",
    activation: { kind: "Readable" },
  }),
  wireItem({
    itemId: "22222222-2222-4222-8222-222222222222",
    mediaId: "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa",
    kind: "podcast_episode",
    title: RUMOR,
    subtitle: { kind: "Present", value: SHOW_TITLE },
    addedAt: "2026-03-05T09:00:00Z",
    activation: footerAudio(),
  }),
  wireItem({
    itemId: "33333333-3333-4333-8333-333333333333",
    mediaId: "aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa",
    kind: "web_article",
    title: DRIFT,
    subtitle: { kind: "Absent" },
    addedAt: "2026-02-05T09:00:00Z",
    activation: { kind: "OpenPane" },
  }),
];

interface StubbedNetwork {
  readonly commandBodies: string[];
}

function stubLecternNetwork(): StubbedNetwork {
  const commandBodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path === "/api/lectern") {
        return Response.json({ data: { items: SNAPSHOT_ITEMS } });
      }
      if (path === "/api/lectern/slate") {
        return Response.json({ data: { items: [] } });
      }
      if (path === "/api/lectern/commands") {
        commandBodies.push(String(init?.body));
        throw new Error("The Lectern pane must not command a view change");
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    }),
  );
  return { commandBodies };
}

function LecternApp({
  initialHref,
  onReplacePane,
  onPublish,
}: {
  readonly initialHref: string;
  readonly onReplacePane: (paneId: string, href: string) => void;
  readonly onPublish: (
    publication: PanePrimaryChromePublication | null,
  ) => void;
}) {
  const [href, setHref] = useState(initialHref);
  const [publication, setPublication] =
    useState<PanePrimaryChromePublication | null>(null);
  const publish = useCallback(
    (update: {
      readonly publication: PanePrimaryChromePublication | null;
    }) => {
      onPublish(update.publication);
      setPublication(update.publication);
    },
    [onPublish],
  );
  const replacePane = useCallback(
    (paneId: string, nextHref: string) => {
      onReplacePane(paneId, nextHref);
      setHref(nextHref);
    },
    [onReplacePane],
  );
  const search = publication?.search;
  return (
    <FeedbackProvider>
      <PaneReturnMementoProvider>
        <PaneReturnVisitScope visitId={"visit" as never} routeKey="lectern">
          <PaneRuntimeProvider
            paneId="pane"
            visitId={"visit" as never}
            isActive
            href={href}
            routeId="lectern"
            canGoBack={false}
            canGoForward={false}
            onNavigatePane={NOOP}
            onReplacePane={replacePane}
            onActivateWorkspaceTarget={ACTIVATE_TARGET}
            onGoBackPane={NOOP}
            onGoForwardPane={NOOP}
          >
            <PanePrimaryChromeProvider publish={publish}>
              <LecternProvider>
                <GlobalPlayerProvider>
                  <LibraryPlacementControllerProvider>
                    <ShareControllerProvider>
                      <div data-pane-content="true">
                        {search ? (
                          <PaneSearchBar publication={search} onClose={NOOP} />
                        ) : null}
                        <LecternPaneBody />
                      </div>
                    </ShareControllerProvider>
                  </LibraryPlacementControllerProvider>
                </GlobalPlayerProvider>
              </LecternProvider>
            </PanePrimaryChromeProvider>
          </PaneRuntimeProvider>
        </PaneReturnVisitScope>
      </PaneReturnMementoProvider>
    </FeedbackProvider>
  );
}

function renderLectern(initialHref = "/lectern") {
  const onReplacePane = vi.fn();
  const chrome: { current: PanePrimaryChromePublication | null } = {
    current: null,
  };
  render(
    <LecternApp
      initialHref={initialHref}
      onReplacePane={onReplacePane}
      onPublish={(publication) => {
        chrome.current = publication;
      }}
    />,
  );
  return { onReplacePane, chrome };
}

function renderedTitles(): string[] {
  return within(screen.getByRole("list", { name: "On the lectern" }))
    .getAllByRole("listitem")
    .map(
      (row) =>
        TITLES.find((title) => row.textContent?.includes(title)) ?? "unknown",
    );
}

function sortControl(): HTMLElement {
  return screen.getByRole("combobox", { name: "Sort by" });
}

function filterInput(): HTMLElement {
  return screen.getByRole("searchbox", { name: "Filter Lectern" });
}

async function openRowMenu(title: string): Promise<void> {
  await userEvent.click(
    screen.getByRole("button", { name: `More actions for ${title}` }),
  );
}

describe("Lectern pane refinement", () => {
  it("replaces the pane URL with the exact sort pair and reorders rows without commanding the Lectern", async () => {
    const network = stubLecternNetwork();
    const { onReplacePane } = renderLectern();

    await waitFor(() => expect(renderedTitles()).toEqual([PARADOX, RUMOR, DRIFT]));

    await userEvent.selectOptions(sortControl(), "title-asc");

    await waitFor(() =>
      expect(onReplacePane).toHaveBeenLastCalledWith(
        "pane",
        "/lectern?sort=title&direction=asc",
      ),
    );
    await waitFor(() => expect(renderedTitles()).toEqual([RUMOR, DRIFT, PARADOX]));
    expect(sortControl()).toHaveValue("title-asc");
    expect(network.commandBodies).toEqual([]);
  });

  it("restores the exact selected sort option and its order from a non-default pane URL", async () => {
    stubLecternNetwork();
    renderLectern("/lectern?sort=added&direction=desc");

    await waitFor(() => expect(renderedTitles()).toEqual([RUMOR, DRIFT, PARADOX]));
    expect(sortControl()).toHaveValue("added-newest");
  });

  it("matches the local filter on the title and the presented subtitle while the folio keeps counting the whole snapshot", async () => {
    stubLecternNetwork();
    const { chrome } = renderLectern();
    await waitFor(() => expect(renderedTitles()).toHaveLength(3));

    await userEvent.type(filterInput(), "signal");

    await waitFor(() => expect(renderedTitles()).toEqual([RUMOR]));
    expect(chrome.current?.header).toMatchObject({
      folio: { kind: "count", value: 3, unit: "item" },
    });

    await userEvent.clear(filterInput());
    await userEvent.type(filterInput(), "drift");
    await waitFor(() => expect(renderedTitles()).toEqual([DRIFT]));

    await userEvent.clear(filterInput());
    await userEvent.type(filterInput(), "nothing matches this");
    expect(await screen.findByText("No items match this filter.")).toBeVisible();
    expect(screen.queryByText("Nothing on the lectern yet.")).toBeNull();
  });

  it("offers reorder only in unfiltered Custom order while remove stays available in every view", async () => {
    stubLecternNetwork();
    renderLectern();
    await waitFor(() => expect(renderedTitles()).toHaveLength(3));

    await openRowMenu(RUMOR);
    expect(screen.getByRole("menuitem", { name: "Move up" })).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Remove from Lectern" }),
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await userEvent.type(filterInput(), "rumor");
    await waitFor(() => expect(renderedTitles()).toEqual([RUMOR]));
    await openRowMenu(RUMOR);
    expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "Remove from Lectern" }),
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await userEvent.clear(filterInput());
    await waitFor(() => expect(renderedTitles()).toHaveLength(3));
    await userEvent.selectOptions(sortControl(), "title-desc");
    await waitFor(() => expect(renderedTitles()).toEqual([PARADOX, DRIFT, RUMOR]));
    await openRowMenu(RUMOR);
    expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "Remove from Lectern" }),
    ).toBeVisible();
  });

  it("retains the local filter text and its matches across a sort change and counts the sort as one active control", async () => {
    stubLecternNetwork();
    const { chrome } = renderLectern();
    await waitFor(() => expect(renderedTitles()).toHaveLength(3));
    expect(chrome.current?.search).toMatchObject({
      activeDomainControlCount: 0,
    });

    await userEvent.type(filterInput(), "e");
    await waitFor(() => expect(renderedTitles()).toEqual([PARADOX, RUMOR, DRIFT]));

    await userEvent.selectOptions(sortControl(), "title-asc");

    await waitFor(() => expect(renderedTitles()).toEqual([RUMOR, DRIFT, PARADOX]));
    expect(filterInput()).toHaveValue("e");
    expect(chrome.current?.search).toMatchObject({
      activeDomainControlCount: 1,
    });
  });

  it("renders Invalid Lectern view with no rows for an unknown sort and restores the canonical view on Reset view", async () => {
    stubLecternNetwork();
    const { onReplacePane } = renderLectern("/lectern?sort=chaos&direction=asc");

    expect(
      await screen.findByText("Invalid Lectern view"),
    ).toBeVisible();
    expect(screen.queryByRole("list", { name: "On the lectern" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Reset view" }));

    await waitFor(() =>
      expect(onReplacePane).toHaveBeenLastCalledWith("pane", "/lectern"),
    );
    await waitFor(() => expect(renderedTitles()).toEqual([PARADOX, RUMOR, DRIFT]));
  });

  it("clears both the local text and the domain view on Clear filters while Escape retains the view", async () => {
    stubLecternNetwork();
    const { onReplacePane } = renderLectern("/lectern?sort=title&direction=asc");
    await waitFor(() => expect(renderedTitles()).toEqual([RUMOR, DRIFT, PARADOX]));

    await userEvent.type(filterInput(), "rumor");
    await waitFor(() => expect(renderedTitles()).toEqual([RUMOR]));

    await userEvent.keyboard("{Escape}");
    expect(filterInput()).toHaveValue("");
    await waitFor(() => expect(renderedTitles()).toEqual([RUMOR, DRIFT, PARADOX]));
    expect(sortControl()).toHaveValue("title-asc");

    await userEvent.type(filterInput(), "rumor");
    await waitFor(() => expect(renderedTitles()).toEqual([RUMOR]));
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() =>
      expect(onReplacePane).toHaveBeenLastCalledWith("pane", "/lectern"),
    );
    await waitFor(() => expect(renderedTitles()).toEqual([PARADOX, RUMOR, DRIFT]));
    expect(filterInput()).toHaveValue("");
    await waitFor(() => expect(sortControl()).toHaveFocus());
  });
});
