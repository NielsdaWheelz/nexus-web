import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import ResourceList from "@/components/ui/ResourceList";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { absent, present } from "@/lib/api/presence";
import type { CollectionRowView } from "@/lib/collections/types";
import { decodePublicationDate } from "@/lib/dates/publicationDate";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import {
  MobileChromeProvider,
  useMobileChrome,
  useMobileChromeReaderScrollport,
} from "@/lib/workspace/mobileChrome";
import CollectionRow from "./CollectionRow";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

function baseRow(): CollectionRowView {
  return {
    id: MEDIA_ID,
    kind: "media",
    primary: { kind: "link", href: `/media/${MEDIA_ID}` },
    title: { text: "Canonical title" },
    contributors: [],
    publicationDate: absent(),
    context: absent(),
    activity: absent(),
    exceptionalStatus: absent(),
    localAvailability: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actionPublication: {
      kind: "ResourceMenu",
      target: routeResourceActionSubject({
        scheme: "media",
        id: MEDIA_ID,
        href: `/media/${MEDIA_ID}`,
      }),
      groups: { core: [], operations: [], relationships: [], view: [] },
    },
    selected: false,
  };
}

function renderRow(ui: ReactNode) {
  return render(
    withRenderEnvironment(
      <MobileChromeProvider>
        <FeedbackProvider>
          <LibraryPlacementControllerProvider>
            <ShareControllerProvider>{ui}</ShareControllerProvider>
          </LibraryPlacementControllerProvider>
        </FeedbackProvider>
      </MobileChromeProvider>,
    ),
  );
}

function MotionPhase() {
  const { motionPhase } = useMobileChrome();
  return <output data-testid="mobile-chrome-phase">{motionPhase.kind}</output>;
}

function ReaderScrollport() {
  const registerScrollport = useMobileChromeReaderScrollport<HTMLDivElement>({
    sourceKey: "collection-row-menu-test",
    enabled: true,
  });
  return (
    <div
      ref={registerScrollport}
      data-testid="reader-scrollport"
      style={{ height: 100, overflowY: "auto" }}
    >
      <div style={{ height: 1_000 }} />
    </div>
  );
}

function mobileMenuTree(showRow: boolean) {
  return withRenderEnvironment(
    <MobileChromeProvider>
      <MotionPhase />
      <ReaderScrollport />
      <FeedbackProvider>
        <LibraryPlacementControllerProvider>
          <ShareControllerProvider>
            {showRow ? (
              <ResourceList ariaLabel="Documents">
                <CollectionRow row={baseRow()} />
              </ResourceList>
            ) : null}
          </ShareControllerProvider>
        </LibraryPlacementControllerProvider>
      </FeedbackProvider>
    </MobileChromeProvider>,
    { initialViewport: "mobile" },
  );
}

describe("CollectionRow", () => {
  it("pins mobile chrome for the row menu lifecycle and releases on close or unmount", async () => {
    const user = userEvent.setup();
    const view = render(mobileMenuTree(true));
    const phase = screen.getByTestId("mobile-chrome-phase");
    const scrollport = screen.getByTestId("reader-scrollport");
    scrollport.scrollTop = 9;
    fireEvent.scroll(scrollport);
    scrollport.scrollTop = 100;
    fireEvent.scroll(scrollport);
    await waitFor(() => expect(phase).toHaveTextContent("Hidden"));

    const trigger = screen.getByRole("button", {
      name: "More actions for Canonical title",
    });
    await user.click(trigger);
    await waitFor(() => expect(phase).toHaveTextContent("Pinned"));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(phase).toHaveTextContent("Visible"));

    await user.click(trigger);
    await waitFor(() => expect(phase).toHaveTextContent("Pinned"));
    view.rerender(mobileMenuTree(false));
    await waitFor(() =>
      expect(screen.getByTestId("mobile-chrome-phase")).toHaveTextContent(
        "Visible",
      ),
    );
  });

  it.each([
    [{ kind: "Resolving" }, "Preparing download…"],
    [{ kind: "Queued", reason: "Capacity" }, "Download queued"],
    [{ kind: "Queued", reason: "WaitingForNetwork" }, "Waiting for network"],
    [{ kind: "Queued", reason: "WaitingForUnmetered" }, "Waiting for Wi-Fi"],
    [{ kind: "Queued", reason: "SystemLimit" }, "Download paused by Android"],
    [
      {
        kind: "Downloading",
        bytesDownloaded: 47,
        totalBytes: present(100),
      },
      "Downloading · 47%",
    ],
    [{ kind: "Restarting" }, "Restarting download…"],
    [{ kind: "Failed", code: "DownloadFailed" }, "Download failed"],
    [{ kind: "Removing" }, "Removing download…"],
  ] as const)("renders offline row milestone %# without a row live region", (state, copy) => {
    renderRow(
      <ResourceList ariaLabel="Episodes">
        <CollectionRow
          row={{
            ...baseRow(),
            kind: "podcast_episode",
            localAvailability: present(state),
          }}
        />
      </ResourceList>,
    );

    expect(screen.getByText(copy)).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("gives active offline state precedence over exceptional and listening state", () => {
    renderRow(
      <ResourceList ariaLabel="Episodes">
        <CollectionRow
          row={{
            ...baseRow(),
            kind: "podcast_episode",
            activity: present({ kind: "Finished", modality: "Listen" }),
            exceptionalStatus: present({
              kind: "MediaProcessing",
              status: "failed",
            }),
            localAvailability: present({
              kind: "Failed",
              code: "DownloadFailed",
            }),
          }}
        />
      </ResourceList>,
    );

    expect(screen.getByText("Download failed")).toBeVisible();
    expect(screen.queryByText("Processing failed")).toBeNull();
    expect(screen.queryByText("Finished")).toBeNull();
  });

  it("keeps Ready as a labeled indicator without hiding the base state", () => {
    renderRow(
      <ResourceList ariaLabel="Episodes">
        <CollectionRow
          row={{
            ...baseRow(),
            kind: "podcast_episode",
            activity: present({ kind: "Finished", modality: "Listen" }),
            exceptionalStatus: present({
              kind: "MediaProcessing",
              status: "suspended",
            }),
            localAvailability: present({
              kind: "Ready",
              sizeBytes: 42,
              contentType: "audio/mpeg",
              updatedAt: "2026-07-30T19:00:00Z",
            }),
          }}
        />
      </ResourceList>,
    );

    expect(screen.getByText("Processing paused")).toBeVisible();
    expect(screen.queryByText("Finished")).toBeNull();
    expect(screen.getByText("Downloaded for offline")).toHaveClass("sr-only");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("publishes one direct Libraries relationship action for media", async () => {
    const user = userEvent.setup();
    renderRow(
      <ResourceList ariaLabel="Documents">
        <CollectionRow row={baseRow()} />
      </ResourceList>,
    );

    await user.click(
      screen.getByRole("button", {
        name: "More actions for Canonical title",
      }),
    );

    expect(
      screen.getAllByRole("menuitem", { name: "Libraries…" }),
    ).toHaveLength(1);
  });

  it("does not publish Libraries for an external target", async () => {
    const user = userEvent.setup();
    renderRow(
      <ResourceList ariaLabel="Documents">
        <CollectionRow
          row={{
            ...baseRow(),
            actionPublication: {
              kind: "ResourceMenu",
              target: {
                kind: "External",
                href: "https://example.test/document",
              },
              groups: {
                core: [],
                operations: [],
                relationships: [],
                view: [],
              },
            },
          }}
        />
      </ResourceList>,
    );

    await user.click(
      screen.getByRole("button", {
        name: "More actions for Canonical title",
      }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "Libraries…" }),
    ).not.toBeInTheDocument();
  });

  it("renders the canonical identity, support, and activity hierarchy", () => {
    const row: CollectionRowView = {
      ...baseRow(),
      contributors: [
        {
          contributor_handle: "ada",
          contributor_display_name: "Ada Author",
          credited_name: "Ada Author",
          role: "author",
          href: "/authors/ada",
        },
        {
          contributor_handle: "grace",
          contributor_display_name: "Grace Author",
          credited_name: "Grace Author",
          role: "author",
          href: "/authors/grace",
        },
        {
          contributor_handle: "third",
          contributor_display_name: "Third Author",
          credited_name: "Third Author",
          role: "author",
          href: "/authors/third",
        },
      ],
      publicationDate: present(decodePublicationDate("2025-02-03", "date")),
      context: present({
        kind: "Snippet",
        segments: [
          { text: "A ", emphasized: false },
          { text: "matched", emphasized: true },
          { text: " context", emphasized: false },
        ],
      }),
      activity: present({
        kind: "InProgress",
        modality: "Read",
        fraction: { kind: "Present", value: { value: 0.42 } },
        remainingMinutes: { kind: "Present", value: { value: 5 } },
      }),
    };

    renderRow(
      <ResourceList ariaLabel="Documents">
        <CollectionRow row={row} />
      </ResourceList>,
    );

    const title = screen.getByRole("link", { name: "Canonical title" });
    const firstContributor = screen.getByRole("link", { name: "Ada Author" });
    expect(title).not.toContainElement(firstContributor);
    expect(screen.getByRole("listitem")).toHaveTextContent(
      /Ada Author, Grace Author, \+1.*February 3, 2025.*A matched context/,
    );
    expect(screen.getByText("42% · ≈5 min left")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      screen.getByText("42 percent complete, about 5 minutes left to read"),
    ).toHaveClass("sr-only");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps exceptional status singular and domain actions in the overflow", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    renderRow(
      <ResourceList ariaLabel="Documents">
        <CollectionRow
          row={{
            ...baseRow(),
            activity: present({ kind: "Finished", modality: "Read" }),
            exceptionalStatus: present({
              kind: "PodcastSync",
              status: "Failed",
            }),
            actionPublication: {
              kind: "FlatMenu",
              actions: [
                {
                  kind: "command",
                  id: "archive",
                  label: "Archive",
                  onSelect: onArchive,
                },
              ],
            },
          }}
        />
      </ResourceList>,
    );

    expect(screen.getByText("Update failed")).toBeVisible();
    expect(screen.queryByText("Finished")).toBeNull();
    const trigger = screen.getByRole("button", {
      name: "More actions for Canonical title",
    });
    expect(trigger.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
    expect(trigger.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledOnce();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps related retrieval lazy until its menu disclosure opens", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { peers: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      renderRow(
        <ResourceList ariaLabel="Documents">
          <CollectionRow
            row={{
              ...baseRow(),
              relatedMediaId: present(MEDIA_ID),
            }}
          />
        </ResourceList>,
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole("button", {
          name: "More actions for Canonical title",
        }),
      );
      await user.click(
        screen.getByRole("menuitem", {
          name: "Show connections and related",
        }),
      );
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(
        `/api/media/${MEDIA_ID}/related`,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
