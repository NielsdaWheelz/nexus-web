import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import {
  readDailyDraft,
  writeDailyDraft,
} from "@/lib/notes/dailyDraftStore";
import {
  createNoteBodyDoc,
  noteBodyValueFromDoc,
} from "@/lib/notes/prosemirror/schema";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import MobileQuickNoteHandoff, {
  type DailyTextHandoffAccepted,
  type MaterializedDailyTextHandoffTarget,
  type MobileQuickNoteHandoffHandle,
} from "./MobileQuickNoteHandoff";

const metrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};
const localDate = "2026-07-31";

function target(initialText: string): MaterializedDailyTextHandoffTarget {
  return {
    kind: "OpenDailyPage",
    date: { kind: "LocalDate", value: localDate },
    entry: {
      kind: "AppendNote",
      initialText,
      noteId: "11111111-1111-4111-8111-111111111111",
      clientMutationId: "mutation-1",
    },
  };
}

const accepted: DailyTextHandoffAccepted = {
  kind: "DailyPageAccepted",
  activationId: "activation-1",
  localDate,
};

function Harness({ initialText }: { initialText: string }) {
  const handoffRef = useRef<MobileQuickNoteHandoffHandle>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          const handoff = handoffRef.current;
          if (!handoff) throw new Error("Handoff is not mounted");
          const prepared = target(initialText);
          handoff.focus();
          handoff.prepare(prepared);
          handoff.accept(prepared, accepted);
        }}
      >
        Add to Today
      </button>
      <MobileQuickNoteHandoff ref={handoffRef} />
    </>
  );
}

function renderHandoff(initialText: string) {
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
            <Harness initialText={initialText} />
          </WorkspaceStoreProvider>
        </PaneReturnMementoProvider>
      </FeedbackProvider>
    </AuthenticatedAccountProvider>,
  );
}

function writePlainDraft(bodyText: string) {
  writeDailyDraft({
    version: 1,
    accountId: "account-1",
    localDate,
    noteId: "11111111-1111-4111-8111-111111111111",
    clientMutationId: "mutation-1",
    ...noteBodyValueFromDoc(createNoteBodyDoc({ fallbackBodyText: bodyText })),
    handoff: { kind: "None" },
  });
}

describe("Mobile daily text handoff", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("appends the seeded tail through the daily owner and keeps buffering against the prepared identity", () => {
    writePlainDraft("Recovered");
    renderHandoff(" Project Ideas");

    fireEvent.click(screen.getByRole("button", { name: "Add to Today" }));

    const input = screen.getByLabelText(
      "Daily note input handoff",
    ) as HTMLTextAreaElement;
    expect(input).toHaveFocus();
    expect(input).toHaveValue(" Project Ideas");
    expect(getComputedStyle(input).fontSize).toBe("16px");
    expect(readDailyDraft("account-1", localDate)).toMatchObject({
      noteId: "11111111-1111-4111-8111-111111111111",
      clientMutationId: "mutation-1",
      bodyText: "Recovered Project Ideas",
      handoff: {
        kind: "Buffered",
        text: "Recovered Project Ideas",
        selectionStart: 23,
        selectionEnd: 23,
      },
    });

    fireEvent.input(input, { target: { value: " Project Ideas and Tasks" } });

    expect(readDailyDraft("account-1", localDate)).toMatchObject({
      bodyText: "Recovered Project Ideas and Tasks",
      handoff: {
        kind: "Buffered",
        text: "Recovered Project Ideas and Tasks",
      },
    });
  });

  it("checkpoints selection and IME composition in the one prepared draft", () => {
    renderHandoff("Seed");
    fireEvent.click(screen.getByRole("button", { name: "Add to Today" }));
    const input = screen.getByLabelText(
      "Daily note input handoff",
    ) as HTMLTextAreaElement;

    input.setSelectionRange(1, 3);
    fireEvent.select(input);
    expect(readDailyDraft("account-1", localDate)?.handoff).toMatchObject({
      kind: "Buffered",
      selectionStart: 1,
      selectionEnd: 3,
      composition: "Complete",
    });

    fireEvent.compositionStart(input);
    fireEvent.input(input, { target: { value: "Seed入力" } });
    expect(readDailyDraft("account-1", localDate)?.handoff).toMatchObject({
      kind: "Buffered",
      text: "Seed入力",
      composition: "Composing",
    });

    fireEvent.compositionEnd(input);
    expect(readDailyDraft("account-1", localDate)?.handoff).toMatchObject({
      kind: "Buffered",
      text: "Seed入力",
      composition: "Complete",
    });
  });

  it("opens an existing atomic draft without installing an empty hidden buffer", () => {
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
      noteId: "11111111-1111-4111-8111-111111111111",
      clientMutationId: "mutation-1",
      bodyPmJson,
      bodyText: "",
      handoff: { kind: "None" },
    });
    renderHandoff("");

    fireEvent.click(screen.getByRole("button", { name: "Add to Today" }));

    expect(screen.getByLabelText("Daily note input handoff")).not.toHaveFocus();
    expect(readDailyDraft("account-1", localDate)).toMatchObject({
      bodyPmJson,
      bodyText: "",
      handoff: { kind: "None" },
    });
  });

  it("retires the exact prior handoff before a newer seed supersedes it", () => {
    const view = renderHandoff(" First");
    const trigger = screen.getByRole("button", { name: "Add to Today" });
    fireEvent.click(trigger);
    const first = readDailyDraft("account-1", localDate);
    if (first?.handoff.kind !== "Buffered") {
      throw new Error("Expected the first daily handoff to be buffered");
    }

    view.rerender(
      <AuthenticatedAccountProvider
        account={{ accountId: "account-1", calendarTimeZone: "UTC" }}
      >
        <FeedbackProvider>
          <PaneReturnMementoProvider>
            <WorkspaceStoreProvider
              workspacePrimaryMetrics={metrics}
              initialState={createDefaultWorkspaceState("/libraries", metrics)}
            >
              <Harness initialText=" Second" />
            </WorkspaceStoreProvider>
          </PaneReturnMementoProvider>
        </FeedbackProvider>
      </AuthenticatedAccountProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to Today" }));

    const second = readDailyDraft("account-1", localDate);
    expect(second).toMatchObject({
      bodyText: "First Second",
      handoff: { kind: "Buffered", text: "First Second" },
    });
    expect(second?.handoff).not.toMatchObject({
      handoffId: first.handoff.handoffId,
    });
  });
});
