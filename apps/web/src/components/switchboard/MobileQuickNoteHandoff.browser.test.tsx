import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import {
  readDailyDraft,
  writeDailyDraft,
} from "@/lib/notes/dailyDraftStore";
import {
  createDefaultWorkspaceState,
  getWorkspacePrimaryPanes,
  MAX_PANES,
} from "@/lib/workspace/schema";
import {
  useWorkspaceStore,
  WorkspaceStoreProvider,
} from "@/lib/workspace/store";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import {
  createNoteBodyDoc,
  emptyNoteBody,
  noteBodyValueFromDoc,
} from "@/lib/notes/prosemirror/schema";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import { useOpenDailyPage } from "@/lib/notes/openDailyPage";
import MobileQuickNoteHandoff, {
  type MobileQuickNoteHandoffHandle,
} from "./MobileQuickNoteHandoff";

const metrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function Harness() {
  const handoffRef = useRef<MobileQuickNoteHandoffHandle>(null);
  const [taskClosed, setTaskClosed] = useState(false);
  const {
    state,
    activateWorkspaceTarget,
    closePane,
    pendingPaneEntryDeliveryByPaneId,
  } = useWorkspaceStore();
  const openDailyPage = useOpenDailyPage();
  const panes = getWorkspacePrimaryPanes(state);
  const activePane = panes.find((pane) => pane.id === state.activePrimaryPaneId);
  const delivery =
    Array.from(pendingPaneEntryDeliveryByPaneId.values())[0] ?? null;

  return (
    <>
      <button
        type="button"
        onClick={(event) =>
          handoffRef.current?.begin(event.currentTarget)
        }
      >
        Begin Quick Note
      </button>
      <button
        type="button"
        onClick={() => {
          for (let index = panes.length; index < MAX_PANES; index += 1) {
            activateWorkspaceTarget({
              originPaneId: state.activePrimaryPaneId,
              target: { href: `/libraries?fork=${index}` },
              disposition: { kind: "Fork" },
              modality: "Pointer",
            });
          }
        }}
      >
        Fill panes
      </button>
      <button
        type="button"
        onClick={() => {
          const candidate = getWorkspacePrimaryPanes(state).find(
            (pane) => pane.id !== state.activePrimaryPaneId,
          );
          if (candidate) closePane(candidate.id);
        }}
      >
        Free pane
      </button>
      <button
        type="button"
        onClick={() => {
          if (activePane) closePane(activePane.id);
        }}
      >
        Close active pane
      </button>
      <button
        type="button"
        onClick={() =>
          openDailyPage(
            {
              kind: "OpenDailyPage",
              localDate: "Today",
              entry: { kind: "View" },
            },
            {
              disposition: { kind: "Adopt" },
              modality: "Pointer",
            },
          )
        }
      >
        Today
      </button>
      <output aria-label="Task closed">{String(taskClosed)}</output>
      <output aria-label="Pane count">{panes.length}</output>
      <output aria-label="Active href">{activePane?.currentVisit.href}</output>
      <output aria-label="Pending entry">
        {delivery ? JSON.stringify(delivery.entry) : "none"}
      </output>
      <MobileQuickNoteHandoff
        ref={handoffRef}
        onNavigationAccepted={() => setTaskClosed(true)}
      />
    </>
  );
}

function renderHandoff() {
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
            <Harness />
          </WorkspaceStoreProvider>
        </PaneReturnMementoProvider>
      </FeedbackProvider>
    </AuthenticatedAccountProvider>,
  );
}

function today(): string {
  return formatLocalDateInTimeZone(new Date(), "UTC");
}

describe("MobileQuickNoteHandoff browser boundary", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("dispatches a recovered draft identity and keeps buffering after task close", async () => {
    const localDate = today();
    writeDailyDraft({
      version: 1,
      accountId: "account-1",
      localDate,
      noteId: "11111111-1111-4111-8111-111111111111",
      clientMutationId: "mutation-recovered",
      ...noteBodyValueFromDoc(
        createNoteBodyDoc({ fallbackBodyText: "Recovered" }),
      ),
      handoff: { kind: "None" },
    });
    renderHandoff();

    fireEvent.click(screen.getByRole("button", { name: "Begin Quick Note" }));

    const input = screen.getByLabelText("Quick Note input handoff");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Recovered");
    expect(getComputedStyle(input).fontSize).toBe("16px");
    expect(screen.getByLabelText("Task closed")).toHaveTextContent("true");
    expect(screen.getByLabelText("Pending entry")).toHaveTextContent(
      '"noteId":"11111111-1111-4111-8111-111111111111"',
    );
    expect(screen.getByLabelText("Pending entry")).toHaveTextContent(
      '"clientMutationId":"mutation-recovered"',
    );

    fireEvent.input(input, { target: { value: "Recovered after close" } });

    await waitFor(() => {
      expect(readDailyDraft("account-1", localDate)?.bodyText).toBe(
        "Recovered after close",
      );
    });
  });

  it("checkpoints selection, paste input, and IME composition in one draft", () => {
    renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Begin Quick Note" }));
    const input = screen.getByLabelText(
      "Quick Note input handoff",
    ) as HTMLTextAreaElement;

    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "pasted");
    fireEvent.paste(input, { clipboardData });
    fireEvent.input(input, { target: { value: "pasted" } });
    input.setSelectionRange(1, 4);
    fireEvent.select(input);
    expect(readDailyDraft("account-1", today())?.handoff).toMatchObject({
      kind: "Buffered",
      text: "pasted",
      selectionStart: 1,
      selectionEnd: 4,
      composition: "Complete",
    });

    fireEvent.compositionStart(input);
    fireEvent.input(input, { target: { value: "pasted入力" } });
    expect(readDailyDraft("account-1", today())?.handoff).toMatchObject({
      kind: "Buffered",
      text: "pasted入力",
      composition: "Composing",
    });

    fireEvent.compositionEnd(input);
    expect(readDailyDraft("account-1", today())?.handoff).toMatchObject({
      kind: "Buffered",
      text: "pasted入力",
      composition: "Complete",
    });
  });

  it("appends gesture-time text without flattening a recovered rich draft", () => {
    const localDate = today();
    const richBodyPmJson = {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Bold",
          marks: [{ type: "strong" }],
        },
        {
          type: "object_ref",
          attrs: {
            objectType: "page",
            objectId: "11111111-1111-4111-8111-111111111111",
            label: "Project",
          },
        },
      ],
    };
    writeDailyDraft({
      version: 1,
      accountId: "account-1",
      localDate,
      noteId: "33333333-3333-4333-8333-333333333333",
      clientMutationId: "mutation-rich",
      bodyPmJson: richBodyPmJson,
      bodyText: "Bold",
      handoff: { kind: "None" },
    });
    renderHandoff();

    fireEvent.click(screen.getByRole("button", { name: "Begin Quick Note" }));
    const input = screen.getByLabelText(
      "Quick Note input handoff",
    ) as HTMLTextAreaElement;
    expect(input).toHaveValue("");
    expect(readDailyDraft("account-1", localDate)?.handoff).toMatchObject({
      kind: "Buffered",
      text: "Bold",
      selectionStart: 4,
      selectionEnd: 4,
    });

    fireEvent.input(input, { target: { value: " added" } });

    const recovered = readDailyDraft("account-1", localDate);
    expect(recovered?.bodyPmJson).toEqual({
      ...richBodyPmJson,
      content: [
        ...(richBodyPmJson.content ?? []),
        { type: "text", text: " added" },
      ],
    });
    expect(recovered?.bodyText).toBe("Bold added");
    expect(recovered?.handoff).toMatchObject({
      kind: "Buffered",
      text: "Bold added",
      selectionStart: 10,
      selectionEnd: 10,
    });
  });

  it("opens a recovered atomic body without flattening it through the gesture input", () => {
    const localDate = today();
    const bodyPmJson = {
      type: "object_embed",
      attrs: {
        objectType: "media",
        objectId: "11111111-1111-4111-8111-111111111111",
        label: "Attachment",
        relationType: "embeds",
        displayMode: "compact",
      },
    };
    writeDailyDraft({
      version: 1,
      accountId: "account-1",
      localDate,
      noteId: "44444444-4444-4444-8444-444444444444",
      clientMutationId: "mutation-atomic",
      bodyPmJson,
      bodyText: "",
      handoff: { kind: "None" },
    });
    renderHandoff();

    fireEvent.click(screen.getByRole("button", { name: "Begin Quick Note" }));

    expect(screen.getByLabelText("Quick Note input handoff")).not.toHaveFocus();
    expect(readDailyDraft("account-1", localDate)).toMatchObject({
      bodyPmJson,
      bodyText: "",
      handoff: { kind: "None" },
    });
    expect(screen.getByLabelText("Task closed")).toHaveTextContent("true");
  });

  it("releases an accepted handoff when its exact pane delivery is closed", async () => {
    renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Begin Quick Note" }));
    const input = screen.getByLabelText(
      "Quick Note input handoff",
    ) as HTMLTextAreaElement;
    fireEvent.input(input, { target: { value: "Keep after close" } });
    expect(input).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Close active pane" }));

    await waitFor(() => expect(input).not.toHaveFocus());
    expect(readDailyDraft("account-1", today())).toMatchObject({
      bodyText: "Keep after close",
      handoff: { kind: "None" },
    });
    expect(screen.getByLabelText("Pending entry")).toHaveTextContent("none");
  });

  it("retires the exact prior bridge before a newer Quick Note supersedes it", async () => {
    renderHandoff();
    const begin = screen.getByRole("button", { name: "Begin Quick Note" });
    fireEvent.click(begin);
    const input = screen.getByLabelText(
      "Quick Note input handoff",
    ) as HTMLTextAreaElement;
    fireEvent.input(input, { target: { value: "First buffer" } });
    const first = readDailyDraft("account-1", today());
    if (first?.handoff.kind !== "Buffered") {
      throw new Error("Expected the first handoff to be buffered");
    }

    fireEvent.click(begin);

    await waitFor(() => expect(input).toHaveFocus());
    const replacement = readDailyDraft("account-1", today());
    expect(replacement).toMatchObject({
      bodyText: "First buffer",
      handoff: { kind: "Buffered", text: "First buffer" },
    });
    expect(replacement?.handoff).not.toMatchObject({
      handoffId: first.handoff.handoffId,
    });

    fireEvent.click(screen.getByRole("button", { name: "Close active pane" }));
    await waitFor(() => expect(input).not.toHaveFocus());
    expect(readDailyDraft("account-1", today())?.handoff).toEqual({
      kind: "None",
    });
  });

  it("cancels a rejected handoff before a later Today view activation", async () => {
    const localDate = today();
    const existingDraft = {
      version: 1 as const,
      accountId: "account-1",
      localDate,
      noteId: "22222222-2222-4222-8222-222222222222",
      clientMutationId: "mutation-before-rejection",
      ...emptyNoteBody(),
      bodyText: "Keep this draft",
      handoff: { kind: "None" as const },
    };
    writeDailyDraft(existingDraft);
    renderHandoff();
    fireEvent.click(screen.getByRole("button", { name: "Fill panes" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Pane count")).toHaveTextContent(
        String(MAX_PANES),
      );
    });

    const quickNote = screen.getByRole("button", {
      name: "Begin Quick Note",
    });
    quickNote.focus();
    fireEvent.click(quickNote);

    expect(quickNote).toHaveFocus();
    expect(readDailyDraft("account-1", localDate)).toEqual(existingDraft);
    expect(screen.getByLabelText("Task closed")).toHaveTextContent("false");
    expect(screen.getByLabelText("Pending entry")).toHaveTextContent("none");

    fireEvent.click(screen.getByRole("button", { name: "Free pane" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Active href")).toHaveTextContent(
        `/daily/${today()}`,
      );
    });
    expect(screen.getByLabelText("Pending entry")).toHaveTextContent("none");
    expect(readDailyDraft("account-1", localDate)).toEqual(existingDraft);
  });
});
