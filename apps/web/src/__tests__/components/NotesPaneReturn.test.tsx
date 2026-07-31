import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  definePaneReturnGeometry,
  PaneShellReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import NotePaneBody from "@/app/(authenticated)/notes/[blockId]/NotePaneBody";
import NotesPaneBody from "@/app/(authenticated)/notes/NotesPaneBody";
import PagePaneBody from "@/app/(authenticated)/pages/[pageId]/PagePaneBody";
import { jsonResponse } from "@/__tests__/helpers/fetch";
import type { NotePage } from "@/lib/notes/api";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { usePaneReturnReady } from "@/lib/panes/paneRuntime";
import type { PaneReturnMementoCommands } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { WorkspaceTestProvider } from "@/__tests__/helpers/WorkspaceTestProvider";

const AWAY_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000092");
const PANE_ID = "notes-return-journey";
const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_NOTE_1 = "22222222-2222-4222-8222-222222222221";
const PAGE_NOTE_2 = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = "33333333-3333-4333-8333-333333333333";

function ReadyAwayBody() {
  usePaneReturnReady(true);
  return <div>Away route</div>;
}

function withLibraryPlacement(children: ReactNode) {
  return (
    <AuthenticatedAccountProvider
      account={{ accountId: "account-1", calendarTimeZone: "UTC" }}
    >
      <WorkspaceTestProvider>
        <LibraryPlacementControllerProvider>
          {children}
        </LibraryPlacementControllerProvider>
      </WorkspaceTestProvider>
    </AuthenticatedAccountProvider>
  );
}

function resourceItem(ref: string, label: string) {
  const [scheme, id] = ref.split(":") as [string, string];
  return {
    ref,
    scheme,
    id,
    label,
    summary: "",
    route: null,
    activation: {
      resourceRef: ref,
      kind: "none",
      href: null,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: {
        userLinkSource: false,
        userLinkTarget: "none",
        noteReferenceTarget: false,
      },
      sharing: "None",
      libraryPlacement: "None",
      attachable: false,
      chatSubject: "none",
      readable: "none",
      inspectable: "none",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: false,
      promptRender: "none",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: { title: 1, body: 1, outgoingEdges: 1 },
  };
}

function noteOccurrence(id: string, text: string) {
  return {
    occurrence_id: `edge-${id}`,
    target: {
      item: resourceItem(`note_block:${id}`, text),
      content: {
        kind: "note_body",
        body_pm_json: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text }],
            },
          ],
        },
        body_text: text,
      },
    },
  };
}

function surface(input: {
  sourceRef: string;
  sourceContent:
    | { kind: "page_title"; title: string }
    | {
        kind: "note_body";
        body_pm_json: Record<string, unknown>;
        body_text: string;
      };
  orderedItems: ReturnType<typeof noteOccurrence>[];
}) {
  return {
    source: {
      item: resourceItem(input.sourceRef, "Return journey"),
      content: input.sourceContent,
    },
    ordered_items: input.orderedItems,
  };
}

function page(updatedAt: string): NotePage {
  return {
    id: PAGE_ID,
    title: "Return journey page",
    actionTarget: routeResourceActionSubject({
      scheme: "page",
      id: PAGE_ID,
      href: `/pages/${PAGE_ID}`,
    }),
    updatedAt,
      dailyPage: null,
  };
}

function stubSurfaceFetch(readSurface: (sourceRef: string) => unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      "http://localhost",
    );
    const match = url.pathname.match(/^\/api\/resource-items\/(.+)\/surface$/);
    if (match) {
      return jsonResponse({ data: readSurface(decodeURIComponent(match[1]!)) });
    }
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Notes route owners — pane return", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("restores the Notes list semantic row after an away visit", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publishCommands = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const href = "/notes";
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    const resources = {
      "notes:pages": [
        {
          id: PAGE_NOTE_1,
          title: "First page",
          description: null,
          updatedAt: "2026-07-01T00:00:00.000Z",
          actionTarget: routeResourceActionSubject({
            scheme: "page",
            id: PAGE_NOTE_1,
            href: `/pages/${PAGE_NOTE_1}`,
          }),
        },
        {
          id: PAGE_NOTE_2,
          title: "Second page",
          description: null,
          updatedAt: "2026-07-02T00:00:00.000Z",
          actionTarget: routeResourceActionSubject({
            scheme: "page",
            id: PAGE_NOTE_2,
            href: `/pages/${PAGE_NOTE_2}`,
          }),
        },
      ],
    };
    const target = (resourceGeneration: number) => (
      <PaneShellReturnJourneyHarness
        href={href}
        visitId={RETURN_JOURNEY_VISIT_ID}
        resources={resources}
        resourceGeneration={resourceGeneration}
        publishCommands={publishCommands}
        paneId={PANE_ID}
      >
        <NotesPaneBody />
      </PaneShellReturnJourneyHarness>
    );
    const away = (
      <PaneShellReturnJourneyHarness
        href="/settings"
        visitId={AWAY_VISIT_ID}
        resources={{}}
        resourceGeneration={1}
        publishCommands={publishCommands}
        paneId={PANE_ID}
      >
        <ReadyAwayBody />
      </PaneShellReturnJourneyHarness>
    );
    const view = render(withLibraryPlacement(target(0)));

    expect(
      await screen.findByRole("link", { name: "Second page" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(commands).not.toBeNull());
    const sourceScrollport = screen.getByTestId("pane-shell-body");
    definePaneReturnGeometry(sourceScrollport, {
      [PAGE_NOTE_1]: 0,
      [PAGE_NOTE_2]: 120,
    });
    act(() => {
      sourceScrollport.scrollTop = 100;
      commands?.capturePane({
        paneId: PANE_ID,
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey,
        modality: "Programmatic",
      });
    });

    view.rerender(withLibraryPlacement(away));
    expect(await screen.findByText("Away route")).toBeInTheDocument();
    view.rerender(withLibraryPlacement(target(2)));

    const restoredScrollport = screen.getByTestId("pane-shell-body");
    expect(
      await screen.findByRole("link", { name: "Second page" }),
    ).toBeInTheDocument();
    definePaneReturnGeometry(restoredScrollport, {
      [PAGE_NOTE_1]: 0,
      [PAGE_NOTE_2]: 120,
    });
    await waitFor(() => expect(restoredScrollport.scrollTop).toBe(100));
    const restoredTitle = screen.getByRole("link", { name: "Second page" });
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: scoped pane-return anchor identity is an explicit DOM capability contract.
    const restoredAnchor = restoredTitle.closest<HTMLElement>(
      "[data-collection-row-id]",
    );
    expect(restoredAnchor).toHaveAttribute(
      "data-collection-row-id",
      PAGE_NOTE_2,
    );
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: anchor ids are collision-safe only within their explicit pane-return scope.
    expect(restoredAnchor?.closest("[data-pane-return-scope]")).toHaveAttribute(
      "data-pane-return-scope",
      "Notes.Pages",
    );
    expect(restoredAnchor?.getBoundingClientRect().top).toBe(20);
  });

  it("clamps the Page raw position when an ordered note is gone", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publishCommands = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const href = `/pages/${PAGE_ID}`;
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    let orderedItems = [
      noteOccurrence(PAGE_NOTE_1, "First ordered note"),
      noteOccurrence(PAGE_NOTE_2, "Removed ordered note"),
    ];
    stubSurfaceFetch((sourceRef) =>
      surface({
        sourceRef,
        sourceContent: { kind: "page_title", title: "Return journey page" },
        orderedItems,
      }),
    );
    const target = (resourceGeneration: number, initialPage: NotePage) => (
      <PaneShellReturnJourneyHarness
        href={href}
        visitId={RETURN_JOURNEY_VISIT_ID}
        resources={{}}
        resourceGeneration={resourceGeneration}
        publishCommands={publishCommands}
        paneId={PANE_ID}
      >
        <PagePaneBody pageIdOverride={PAGE_ID} initialPage={initialPage} />
      </PaneShellReturnJourneyHarness>
    );
    const away = (
      <PaneShellReturnJourneyHarness
        href="/settings"
        visitId={AWAY_VISIT_ID}
        resources={{}}
        resourceGeneration={1}
        publishCommands={publishCommands}
        paneId={PANE_ID}
      >
        <ReadyAwayBody />
      </PaneShellReturnJourneyHarness>
    );
    const view = render(
      withLibraryPlacement(target(0, page("2026-07-01T00:00:00.000Z"))),
    );

    expect(await screen.findByText("Removed ordered note")).toBeInTheDocument();
    await waitFor(() => expect(commands).not.toBeNull());
    const sourceScrollport = screen.getByTestId("pane-shell-body");
    definePaneReturnGeometry(sourceScrollport, {
      [`edge-${PAGE_NOTE_1}`]: 0,
      [`edge-${PAGE_NOTE_2}`]: 120,
    });
    act(() => {
      sourceScrollport.scrollTop = 100;
      commands?.capturePane({
        paneId: PANE_ID,
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey,
        modality: "Programmatic",
      });
    });

    view.rerender(withLibraryPlacement(away));
    expect(await screen.findByText("Away route")).toBeInTheDocument();
    const awayScrollport = screen.getByTestId("pane-shell-body");
    definePaneReturnGeometry(awayScrollport, {}, { scrollHeight: 140 });
    orderedItems = [noteOccurrence(PAGE_NOTE_1, "First ordered note")];
    view.rerender(
      withLibraryPlacement(target(2, page("2026-07-02T00:00:00.000Z"))),
    );

    expect(await screen.findByText("First ordered note")).toBeInTheDocument();
    expect(screen.queryByText("Removed ordered note")).not.toBeInTheDocument();
    await waitFor(() => expect(awayScrollport.scrollTop).toBe(40));
  });

  it("restores the Note ordered-resource anchor after an away visit", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publishCommands = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const href = `/notes/${NOTE_ID}`;
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    stubSurfaceFetch((sourceRef) =>
      surface({
        sourceRef,
        sourceContent: {
          kind: "note_body",
          body_pm_json: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Note masthead" }],
              },
            ],
          },
          body_text: "Note masthead",
        },
        orderedItems: [noteOccurrence(PAGE_NOTE_1, "Standalone return note")],
      }),
    );
    const target = (resourceGeneration: number) => (
      <PaneShellReturnJourneyHarness
        href={href}
        visitId={RETURN_JOURNEY_VISIT_ID}
        resources={{}}
        resourceGeneration={resourceGeneration}
        publishCommands={publishCommands}
        paneId={PANE_ID}
      >
        <NotePaneBody />
      </PaneShellReturnJourneyHarness>
    );
    const away = (
      <PaneShellReturnJourneyHarness
        href="/settings"
        visitId={AWAY_VISIT_ID}
        resources={{}}
        resourceGeneration={1}
        publishCommands={publishCommands}
        paneId={PANE_ID}
      >
        <ReadyAwayBody />
      </PaneShellReturnJourneyHarness>
    );
    const view = render(withLibraryPlacement(target(0)));

    expect(
      await screen.findByText("Standalone return note"),
    ).toBeInTheDocument();
    await waitFor(() => expect(commands).not.toBeNull());
    const sourceScrollport = screen.getByTestId("pane-shell-body");
    definePaneReturnGeometry(sourceScrollport, {
      [`edge-${PAGE_NOTE_1}`]: 120,
    });
    act(() => {
      sourceScrollport.scrollTop = 100;
      commands?.capturePane({
        paneId: PANE_ID,
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey,
        modality: "Programmatic",
      });
    });

    view.rerender(withLibraryPlacement(away));
    expect(await screen.findByText("Away route")).toBeInTheDocument();
    view.rerender(withLibraryPlacement(target(2)));

    const restoredScrollport = screen.getByTestId("pane-shell-body");
    expect(
      await screen.findByText("Standalone return note"),
    ).toBeInTheDocument();
    definePaneReturnGeometry(restoredScrollport, {
      [`edge-${PAGE_NOTE_1}`]: 120,
    });
    await waitFor(() => expect(restoredScrollport.scrollTop).toBe(100));
  });
});
