import { useMemo, useState } from "react";
import { StickyNote } from "lucide-react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { useAddContentSession } from "@/components/nexus/useAddContentSession";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import type {
  NexusEntry,
  NexusEntryKey,
  NexusPage,
  NexusProjection,
} from "@/lib/nexus/model";
import { readDailyDraft } from "@/lib/notes/dailyDraftStore";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import NexusButton from "./NexusButton";
import SwitchboardTask, {
  type MobileNexusTaskController,
} from "./SwitchboardTask";

const metrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

const dailyEntry: NexusEntry = {
  key: { kind: "QuickAction", actionId: "Nexus.Quick.Note" },
  historySource: "Static",
  label: "Quick Note",
  icon: StickyNote,
  primaryAction: {
    id: "quick-note",
    label: "Quick Note",
    icon: StickyNote,
    activation: { kind: "DailyTextHandoff" },
    availability: {
      kind: "Available",
      target: {
        kind: "OpenDailyPage",
        date: { kind: "Today" },
        entry: { kind: "AppendNote", initialText: "Project Ideas" },
      },
    },
  },
  secondaryActions: [],
  rank: { tier: "Exact", score: 1, frecency: 0 },
};

function Harness({ daily = false }: { daily?: boolean }) {
  const addSession = useAddContentSession();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<NexusPage>({ kind: "Root" });
  const [activeKey, setActiveKey] = useState<NexusEntryKey | null>(
    daily ? dailyEntry.key : null,
  );
  const projection = useMemo<NexusProjection>(
    () => ({
      surface: "Mobile",
      activeKey,
      groups: [
        { id: "Open", label: "Open", layout: "CompactRail", entries: [] },
        {
          id: "QuickActions",
          label: "Quick Actions",
          layout: "CompactRail",
          entries: daily ? [dailyEntry] : [],
        },
        {
          id: "Continue",
          label: "Continue",
          layout: "CompactRail",
          entries: [],
        },
        {
          id: "Recent",
          label: "Recent",
          layout: "CompactRail",
          entries: [],
        },
        {
          id: "Places",
          label: "Places",
          layout: "CompactRail",
          entries: [],
        },
      ],
    }),
    [activeKey, daily],
  );
  const close = () => setOpen(false);
  const controller: MobileNexusTaskController = {
    query,
    page,
    projection,
    actionsRequest: null,
    failures: new Set(),
    busy: false,
    pending: false,
    announcement: "",
    dialogLabel: "Nexus",
    focusKey: `${page.kind}:${query.length > 0 ? "typed" : "blank"}`,
    addSession,
    dismissalConfirmation: null,
    createChoiceActions: [],
    browseChoiceActions: [],
    managedPanes: [],
    managedClosedPanes: [],
    setQuery,
    setActiveEntry: setActiveKey,
    openEntryActions: (entry) => setPage({ kind: "EntryActions", entry }),
    announceUnavailable: () => undefined,
    materialize: (target) => {
      if (target.kind !== "OpenDailyPage") return target;
      if (target.entry.kind === "View") {
        return {
          kind: "OpenDailyPage",
          date: { kind: "LocalDate", value: "2026-07-31" },
          entry: { kind: "View" },
        };
      }
      return {
        ...target,
        date: { kind: "LocalDate", value: "2026-07-31" },
        entry: {
          ...target.entry,
          noteId: "11111111-1111-4111-8111-111111111111",
          clientMutationId: "mutation-1",
        },
      };
    },
    dispatch: async (target) => {
      if (daily && target.kind === "OpenDailyPage") {
        setOpen(false);
        return {
          kind: "DailyPageAccepted",
          activationId: "activation-1",
          localDate: "2026-07-31",
        };
      }
      return { kind: "Stayed" };
    },
    reportActivationFailure: () => undefined,
    retry: () => undefined,
    back: () => setPage({ kind: "Root" }),
    escape: () => {
      if (query.length > 0) setQuery("");
      else close();
    },
    close,
    dismissAccepted: close,
    guardClose: () => {
      if (query.length > 0) {
        setQuery("");
        return "blocked";
      }
      return "accepted";
    },
    initialFocus: (container) => {
      // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: this is the production modal selector contract, not a test assertion.
      return container.querySelector<HTMLElement>(
        "[data-mobile-nexus-search]",
      );
    },
    shouldSuppressReturnFocusOnClose: () => daily,
    openTarget: () => undefined,
    openAddTarget: () => undefined,
    keepWorking: () => undefined,
    confirmDismissal: () => undefined,
    setLibraryNameDraft: () => undefined,
    submitLibrary: () => undefined,
    retryPageCreation: () => undefined,
    manageTabs: () => undefined,
    openManagedPane: () => undefined,
    closeManagedPane: () => undefined,
    restoreManagedPane: () => undefined,
    retryRetainedActivation: () => undefined,
    cancelRetainedActivation: () => undefined,
  };

  return (
    <>
      <NexusButton
        paneCount={1}
        switchboardOpen={open}
        onOpen={() => setOpen(true)}
      />
      <SwitchboardTask
        controller={controller}
        active={open}
        activeAddDefect={false}
        onAddDefect={() => undefined}
        onClearAddDefect={() => undefined}
      />
    </>
  );
}

function renderTask(daily = false) {
  return render(
    withRenderEnvironment(
      <AuthenticatedAccountProvider
        account={{ accountId: "account-1", calendarTimeZone: "UTC" }}
      >
        <FeedbackProvider>
          <PaneReturnMementoProvider>
            <WorkspaceStoreProvider
              workspacePrimaryMetrics={metrics}
              initialState={createDefaultWorkspaceState("/libraries", metrics)}
            >
              <MobileChromeProvider>
                <Harness daily={daily} />
              </MobileChromeProvider>
            </WorkspaceStoreProvider>
          </PaneReturnMementoProvider>
        </FeedbackProvider>
      </AuthenticatedAccountProvider>,
      { initialViewport: "mobile" },
    ),
  );
}

describe("mobile Nexus full-screen task", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(history, "pushState").mockImplementation(() => undefined);
    vi.spyOn(history, "replaceState").mockImplementation(() => undefined);
    vi.spyOn(history, "back").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("keeps gesture-flush focus on search and clears the query before Escape dismisses", async () => {
    renderTask();

    fireEvent.click(screen.getByRole("button", { name: /Open Nexus/ }));

    const search = screen.getByRole("searchbox", { name: "Find anything…" });
    expect(search).toHaveFocus();
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "Project Ideas" } });
    fireEvent.keyDown(search, { key: "Escape" });

    expect(search).toHaveValue("");
    expect(screen.getByRole("dialog", { name: "Nexus" })).toBeVisible();

    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();
  });

  it("keeps the daily handoff mounted and editable after accepted navigation closes the task", async () => {
    renderTask(true);
    fireEvent.click(screen.getByRole("button", { name: /Open Nexus/ }));

    fireEvent.click(screen.getByRole("button", { name: "Quick Note" }));

    const handoff = screen.getByLabelText(
      "Daily note input handoff",
    ) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Nexus" })).toBeNull();
      expect(handoff).toHaveFocus();
    });
    expect(readDailyDraft("account-1", "2026-07-31")?.bodyText).toBe(
      "Project Ideas",
    );

    fireEvent.input(handoff, {
      target: { value: "Project Ideas and Tasks" },
    });

    expect(readDailyDraft("account-1", "2026-07-31")?.bodyText).toBe(
      "Project Ideas and Tasks",
    );
  });
});
