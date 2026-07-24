import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  definePaneReturnGeometry,
  PaneShellReturnJourneyHarness,
  RETURN_JOURNEY_VISIT_ID,
} from "@/__tests__/helpers/paneReturnJourney";
import NotePaneBody from "@/app/(authenticated)/notes/[blockId]/NotePaneBody";
import NotesPaneBody from "@/app/(authenticated)/notes/NotesPaneBody";
import PagePaneBody from "@/app/(authenticated)/pages/[pageId]/PagePaneBody";
import type { NotePage } from "@/lib/notes/api";
import type { NoteBlock } from "@/lib/notes/normalize";
import { paragraphFromText } from "@/lib/notes/prosemirror/schema";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { usePaneReturnReady } from "@/lib/panes/paneRuntime";
import type { PaneReturnMementoCommands } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";

const AWAY_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000092",
);
const PANE_ID = "notes-return-journey";
const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_BLOCK_1 = "22222222-2222-4222-8222-222222222221";
const PAGE_BLOCK_2 = "22222222-2222-4222-8222-222222222222";
const NOTE_BLOCK_ID = "33333333-3333-4333-8333-333333333333";

function ReadyAwayBody() {
  usePaneReturnReady(true);
  return <div>Away route</div>;
}

function noteBlock(id: string, text: string): NoteBlock {
  return {
    id,
    parentBlockId: null,
    orderKey: "0000000001",
    bodyPmJson: paragraphFromText(text).toJSON() as Record<string, unknown>,
    bodyText: text,
    collapsed: false,
    children: [],
    versionByLane: { body: 1, outgoing_edges: 1 },
  };
}

function page(blocks: NoteBlock[], updatedAt: string): NotePage {
  return {
    id: PAGE_ID,
    title: "Return journey page",
    surface: null,
    updatedAt,
    dailyNote: null,
    blocks,
  };
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
          id: "page-1",
          title: "First page",
          description: null,
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "page-2",
          title: "Second page",
          description: null,
          updatedAt: "2026-07-02T00:00:00.000Z",
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
    const view = render(target(0));

    expect(await screen.findByText("Second page")).toBeInTheDocument();
    await waitFor(() => expect(commands).not.toBeNull());
    const sourceScrollport = screen.getByTestId("pane-shell-body");
    definePaneReturnGeometry(sourceScrollport, {
      "page-1": 0,
      "page-2": 120,
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

    view.rerender(away);
    expect(await screen.findByText("Away route")).toBeInTheDocument();
    view.rerender(target(2));

    const restoredScrollport = screen.getByTestId("pane-shell-body");
    expect(await screen.findByText("Second page")).toBeInTheDocument();
    definePaneReturnGeometry(restoredScrollport, {
      "page-1": 0,
      "page-2": 120,
    });
    await waitFor(() => expect(restoredScrollport.scrollTop).toBe(100));
    const restoredTitle = screen.getByText("Second page");
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: scoped pane-return anchor identity is an explicit DOM capability contract.
    const restoredAnchor = restoredTitle.closest<HTMLElement>(
      "[data-collection-row-id]",
    );
    expect(restoredAnchor).toHaveAttribute("data-collection-row-id", "page-2");
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: anchor ids are collision-safe only within their explicit pane-return scope.
    expect(restoredAnchor?.closest("[data-pane-return-scope]")).toHaveAttribute(
      "data-pane-return-scope",
      "Notes.Pages",
    );
    expect(restoredAnchor?.getBoundingClientRect().top).toBe(20);
  });

  it("clamps the Page raw position when the saved editor block is gone", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publishCommands = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const href = `/pages/${PAGE_ID}`;
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    const firstBlock = noteBlock(PAGE_BLOCK_1, "First editor block");
    const secondBlock = noteBlock(PAGE_BLOCK_2, "Removed editor block");
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
      target(
        0,
        page(
          [firstBlock, { ...secondBlock, orderKey: "0000000002" }],
          "2026-07-01T00:00:00.000Z",
        ),
      ),
    );

    expect(await screen.findByText("Removed editor block")).toBeInTheDocument();
    await waitFor(() => expect(commands).not.toBeNull());
    const sourceScrollport = screen.getByTestId("pane-shell-body");
    definePaneReturnGeometry(sourceScrollport, {
      [PAGE_BLOCK_1]: 0,
      [PAGE_BLOCK_2]: 120,
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

    view.rerender(away);
    expect(await screen.findByText("Away route")).toBeInTheDocument();
    const awayScrollport = screen.getByTestId("pane-shell-body");
    definePaneReturnGeometry(awayScrollport, {}, { scrollHeight: 140 });
    view.rerender(
      target(
        2,
        page([firstBlock], "2026-07-02T00:00:00.000Z"),
      ),
    );

    expect(await screen.findByText("First editor block")).toBeInTheDocument();
    expect(screen.queryByText("Removed editor block")).not.toBeInTheDocument();
    await waitFor(() => expect(awayScrollport.scrollTop).toBe(40));
  });

  it("restores the Note editor-block anchor after an away visit", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publishCommands = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const href = `/notes/${NOTE_BLOCK_ID}`;
    const routeKey = resolvePaneRouteIdentity(href).routeKey;
    const block = noteBlock(NOTE_BLOCK_ID, "Standalone return note");
    const target = (resourceGeneration: number) => (
      <PaneShellReturnJourneyHarness
        href={href}
        visitId={RETURN_JOURNEY_VISIT_ID}
        resources={{ [`note-block:${NOTE_BLOCK_ID}`]: block }}
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
    const view = render(target(0));

    expect(await screen.findByText("Standalone return note")).toBeInTheDocument();
    await waitFor(() => expect(commands).not.toBeNull());
    const sourceScrollport = screen.getByTestId("pane-shell-body");
    definePaneReturnGeometry(sourceScrollport, { [NOTE_BLOCK_ID]: 120 });
    act(() => {
      sourceScrollport.scrollTop = 100;
      commands?.capturePane({
        paneId: PANE_ID,
        visitId: RETURN_JOURNEY_VISIT_ID,
        routeKey,
        modality: "Programmatic",
      });
    });

    view.rerender(away);
    expect(await screen.findByText("Away route")).toBeInTheDocument();
    view.rerender(target(2));

    const restoredScrollport = screen.getByTestId("pane-shell-body");
    expect(await screen.findByText("Standalone return note")).toBeInTheDocument();
    definePaneReturnGeometry(restoredScrollport, { [NOTE_BLOCK_ID]: 120 });
    await waitFor(() => expect(restoredScrollport.scrollTop).toBe(100));
    const restoredText = screen.getByText("Standalone return note");
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: scoped pane-return anchor identity is an explicit DOM capability contract.
    const restoredAnchor = restoredText.closest<HTMLElement>(
      "[data-note-block-id]",
    );
    expect(restoredAnchor).toHaveAttribute(
      "data-note-block-id",
      NOTE_BLOCK_ID,
    );
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: anchor ids are collision-safe only within their explicit pane-return scope.
    expect(restoredAnchor?.closest("[data-pane-return-scope]")).toHaveAttribute(
      "data-pane-return-scope",
      "Notes.EditorBlocks",
    );
    expect(restoredAnchor?.getBoundingClientRect().top).toBe(20);
  });
});
