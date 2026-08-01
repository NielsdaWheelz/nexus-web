import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { StickyNote } from "lucide-react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import type {
  MaterializedNexusTarget,
  NexusDispatchOutcome,
} from "@/lib/nexus/dispatch";
import type {
  NexusAction,
  NexusTarget,
  NexusTargetActivation,
} from "@/lib/nexus/model";
import {
  dailyDraftKey,
  readDailyDraft,
  subscribeDailyDraft,
  writeDailyDraft,
} from "@/lib/notes/dailyDraftStore";
import {
  createNoteBodyDoc,
  noteBodyValueFromDoc,
} from "@/lib/notes/prosemirror/schema";
import { useResourceSurfaceSession } from "@/lib/resourceSurface/useResourceSurfaceSession";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import type { PaneEntryDelivery } from "@/lib/workspace/targetActivation";
import MobileNexusActivationAdapter, {
  type MobileNexusActivationAdapterHandle,
} from "./MobileNexusActivationAdapter";

const metrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};
const activation: NexusTargetActivation = {
  disposition: { kind: "Follow" },
  modality: "Pointer",
};
const dailyTarget: NexusTarget = {
  kind: "OpenDailyPage",
  date: { kind: "Today" },
  entry: { kind: "AppendNote", initialText: "Project Ideas" },
};
const preparedDailyTarget: MaterializedNexusTarget = {
  kind: "OpenDailyPage",
  date: { kind: "LocalDate", value: "2026-07-31" },
  entry: {
    kind: "AppendNote",
    initialText: "Project Ideas",
    noteId: "11111111-1111-4111-8111-111111111111",
    clientMutationId: "mutation-1",
  },
};

function action(
  target: NexusTarget,
  activationKind: NexusAction["activation"]["kind"],
): NexusAction {
  return {
    id: "test-action",
    label: "Test action",
    icon: StickyNote,
    activation: { kind: activationKind },
    availability: { kind: "Available", target },
  };
}

function Harness({
  nexusAction,
  materialize,
  dispatch,
}: {
  nexusAction: NexusAction;
  materialize(target: NexusTarget): MaterializedNexusTarget;
  dispatch(
    target: MaterializedNexusTarget,
    targetActivation: NexusTargetActivation,
  ): Promise<NexusDispatchOutcome>;
}) {
  const adapterRef = useRef<MobileNexusActivationAdapterHandle>(null);
  return (
    <>
      <button
        type="button"
        onClick={(event) =>
          adapterRef.current?.activate(
            nexusAction,
            activation,
            event.currentTarget,
          )
        }
      >
        Activate
      </button>
      <MobileNexusActivationAdapter
        ref={adapterRef}
        materialize={materialize}
        dispatch={dispatch}
        onError={vi.fn()}
      />
    </>
  );
}

function renderAdapter(props: Parameters<typeof Harness>[0]) {
  return render(
    <AuthenticatedAccountProvider
      account={{ accountId: "account-1", calendarTimeZone: "UTC" }}
    >
      <FeedbackProvider>
        <PaneReturnMementoProvider>
          <WorkspaceStoreProvider
            workspacePrimaryMetrics={metrics}
            initialState={createDefaultWorkspaceState("/libraries", metrics)}
          >
            <Harness {...props} />
          </WorkspaceStoreProvider>
        </PaneReturnMementoProvider>
      </FeedbackProvider>
    </AuthenticatedAccountProvider>,
  );
}

const serverDraftSnapshot = () => null;

function useDailyDraftSnapshot() {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeDailyDraft("account-1", "2026-07-31", listener),
    [],
  );
  const getSnapshot = useCallback(
    () => localStorage.getItem(dailyDraftKey("account-1", "2026-07-31")),
    [],
  );
  const raw = useSyncExternalStore(
    subscribe,
    getSnapshot,
    serverDraftSnapshot,
  );
  return useMemo(
    () =>
      raw === null ? null : readDailyDraft("account-1", "2026-07-31"),
    [raw],
  );
}

function SeededDeliveryHarness() {
  const adapterRef = useRef<MobileNexusActivationAdapterHandle>(null);
  const [delivery, setDelivery] = useState<PaneEntryDelivery | null>(null);
  const draftSnapshot = useDailyDraftSnapshot();
  const session = useResourceSurfaceSession({
    sessionKey: "daily:account-1:2026-07-31",
    daily: { accountId: "account-1", localDate: "2026-07-31" },
    delivery,
    draftSnapshot,
  });
  const materialize = useCallback(
    (_target: NexusTarget): MaterializedNexusTarget => preparedDailyTarget,
    [],
  );
  const dispatch = useCallback(
    async (
      target: MaterializedNexusTarget,
    ): Promise<NexusDispatchOutcome> => {
      if (target.kind !== "OpenDailyPage" || target.entry.kind !== "AppendNote") {
        throw new Error("Expected a prepared daily AppendNote target");
      }
      setDelivery({
        activationId: "activation-1",
        paneId: "pane-1",
        visitId: "visit-1",
        entry: target.entry,
      });
      return {
        kind: "DailyPageAccepted",
        activationId: "activation-1",
        localDate: "2026-07-31",
      };
    },
    [],
  );

  return (
    <>
      <button
        type="button"
        onClick={(event) =>
          adapterRef.current?.activate(
            action(dailyTarget, "DailyTextHandoff"),
            activation,
            event.currentTarget,
          )
        }
      >
        Seed Today
      </button>
      <output aria-label="Daily provisional body">
        {session.provisional?.bodyText ?? ""}
      </output>
      <MobileNexusActivationAdapter
        ref={adapterRef}
        materialize={materialize}
        dispatch={dispatch}
        onError={vi.fn()}
      />
    </>
  );
}

function renderSeededDelivery() {
  return render(
    <AuthenticatedAccountProvider
      account={{ accountId: "account-1", calendarTimeZone: "UTC" }}
    >
      <FeedbackProvider>
        <PaneReturnMementoProvider>
          <WorkspaceStoreProvider
            workspacePrimaryMetrics={metrics}
            initialState={createDefaultWorkspaceState("/libraries", metrics)}
          >
            <SeededDeliveryHarness />
          </WorkspaceStoreProvider>
        </PaneReturnMementoProvider>
      </FeedbackProvider>
    </AuthenticatedAccountProvider>,
  );
}

describe("Mobile Nexus activation adapter", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("focuses the handoff before one shared materialization and dispatch", async () => {
    const materialize = vi.fn((_target: NexusTarget) => {
      expect(screen.getByLabelText("Daily note input handoff")).toHaveFocus();
      return preparedDailyTarget;
    });
    const dispatch = vi.fn(
      async (): Promise<NexusDispatchOutcome> => ({
        kind: "DailyPageAccepted",
        activationId: "activation-1",
        localDate: "2026-07-31",
      }),
    );
    renderAdapter({
      nexusAction: action(dailyTarget, "DailyTextHandoff"),
      materialize,
      dispatch,
    });

    fireEvent.click(screen.getByRole("button", { name: "Activate" }));

    expect(materialize).toHaveBeenCalledOnce();
    expect(materialize).toHaveBeenCalledWith(dailyTarget);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(preparedDailyTarget, activation);
    await waitFor(() => {
      expect(readDailyDraft("account-1", "2026-07-31")).toMatchObject({
        noteId: "11111111-1111-4111-8111-111111111111",
        clientMutationId: "mutation-1",
        bodyText: "Project Ideas",
        handoff: { kind: "Buffered", text: "Project Ideas" },
      });
    });
  });

  it("uses the same materialize and dispatch callbacks for Standard actions", async () => {
    const target: NexusTarget = {
      kind: "InternalHref",
      href: "/libraries",
    };
    const materialize = vi.fn((_target: NexusTarget) => target);
    const dispatch = vi.fn(
      async (): Promise<NexusDispatchOutcome> => ({
        kind: "NavigationAccepted",
      }),
    );
    renderAdapter({
      nexusAction: action(target, "Standard"),
      materialize,
      dispatch,
    });

    fireEvent.click(screen.getByRole("button", { name: "Activate" }));

    expect(materialize).toHaveBeenCalledOnce();
    expect(materialize).toHaveBeenCalledWith(target);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(target, activation);
    await waitFor(() => {
      expect(
        screen.getByLabelText("Daily note input handoff"),
      ).not.toHaveFocus();
    });
  });

  it("restores the exact trigger and writes no draft after rejected navigation", async () => {
    const materialize = vi.fn((_target: NexusTarget) => preparedDailyTarget);
    const dispatch = vi.fn(
      async (): Promise<NexusDispatchOutcome> => ({
        kind: "NavigationRejected",
        reason: "PaneLimitReached",
        target: { kind: "InternalHref", href: "/daily/2026-07-31" },
      }),
    );
    renderAdapter({
      nexusAction: action(dailyTarget, "DailyTextHandoff"),
      materialize,
      dispatch,
    });
    const trigger = screen.getByRole("button", { name: "Activate" });

    fireEvent.click(trigger);

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(readDailyDraft("account-1", "2026-07-31")).toBeNull();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("restores the exact prior draft after rejected seeded navigation", async () => {
    const priorDraft = {
      version: 1 as const,
      accountId: "account-1",
      localDate: "2026-07-31",
      noteId: "11111111-1111-4111-8111-111111111111",
      clientMutationId: "mutation-1",
      ...noteBodyValueFromDoc(
        createNoteBodyDoc({ fallbackBodyText: "Recovered" }),
      ),
      handoff: { kind: "None" as const },
    };
    writeDailyDraft(priorDraft);
    const materialize = vi.fn((_target: NexusTarget) => preparedDailyTarget);
    const dispatch = vi.fn(
      async (): Promise<NexusDispatchOutcome> => ({
        kind: "NavigationRejected",
        reason: "PaneLimitReached",
        target: { kind: "InternalHref", href: "/daily/2026-07-31" },
      }),
    );
    renderAdapter({
      nexusAction: action(dailyTarget, "DailyTextHandoff"),
      materialize,
      dispatch,
    });
    const trigger = screen.getByRole("button", { name: "Activate" });

    fireEvent.click(trigger);

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(readDailyDraft("account-1", "2026-07-31")).toEqual(priorDraft);
  });

  it("materializes seeded daily text exactly once when the editor claims the buffered identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              kind: "Latent",
              localDate: "2026-07-31",
              defaultTitle: "Friday, July 31",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
    renderSeededDelivery();

    fireEvent.click(screen.getByRole("button", { name: "Seed Today" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Daily provisional body")).toHaveTextContent(
        "Project Ideas",
      ),
    );
    expect(
      screen.getByLabelText("Daily provisional body").textContent,
    ).toBe("Project Ideas");
    expect(readDailyDraft("account-1", "2026-07-31")?.bodyText).toBe(
      "Project Ideas",
    );
  });
});
