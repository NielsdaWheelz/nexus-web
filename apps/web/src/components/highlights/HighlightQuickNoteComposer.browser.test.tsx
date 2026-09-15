import {
  Component,
  StrictMode,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import SelectionPopover from "@/components/SelectionPopover";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import HighlightNoteEditor from "@/components/notes/HighlightNoteEditor";
import { deleteHighlightNote, saveHighlightNote } from "@/lib/highlights/api";
import type { HighlightLinkedNoteBlock } from "@/lib/highlights/highlightContract";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import HighlightQuickNoteComposer, {
  type QuickNoteSession,
} from "./HighlightQuickNoteComposer";

const HIGHLIGHT_ID = "11111111-1111-4111-8111-111111111111";
const QUOTE = "There is water ice at the lunar south pole.";

interface PendingSave {
  body: {
    note_block_id: string;
    client_mutation_id: string;
    body_pm_json: Record<string, unknown>;
  };
  resolve: (response: Response) => void;
}

class DefectBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(_error: Error, _errorInfo: ErrorInfo) {}

  render() {
    return this.state.error ? (
      <p role="status">Annotation defect</p>
    ) : (
      this.props.children
    );
  }
}

// The browser owns selection, focus, editing, draft recovery, and submit. Only
// the BFF response is held so a save cannot succeed before the scenario allows it.
function holdNoteSaves() {
  const pending: PendingSave[] = [];
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.origin,
      );
      if (
        url.pathname !== `/api/highlights/${HIGHLIGHT_ID}/note` ||
        init?.method !== "PUT"
      ) {
        throw new Error(`Unexpected annotation request: ${init?.method} ${url}`);
      }
      const body = JSON.parse(String(init.body)) as PendingSave["body"];
      return new Promise<Response>((resolve) => pending.push({ body, resolve }));
    },
  );
  return pending;
}

function acceptSave(save: PendingSave, bodyText: string) {
  save.resolve(
    new Response(
      JSON.stringify({
        data: {
          note_block_id: save.body.note_block_id,
          body_pm_json: save.body.body_pm_json,
          body_text: bodyText,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
}

function SelectionAnnotation({
  initiallyOpen = false,
  creation,
}: {
  initiallyOpen?: boolean;
  creation?: Promise<{ id: string } | null>;
}) {
  const passageRef = useRef<HTMLParagraphElement>(null);
  const [selecting, setSelecting] = useState(!initiallyOpen);
  const [session, setSession] = useState<QuickNoteSession | null>(
    initiallyOpen
      ? {
          kind: "existing",
          highlightId: HIGHLIGHT_ID,
          quote: QUOTE,
          note: null,
          anchorRect: new DOMRect(20, 20, 200, 20),
        }
      : null,
  );
  const [savedNote, setSavedNote] = useState<HighlightLinkedNoteBlock | null>(null);

  function openNote() {
    const anchorRect = passageRef.current!.getBoundingClientRect();
    setSelecting(false);
    setSession(
      creation
        ? {
            kind: "pending-create",
            sessionId: "selection-awaiting-highlight",
            quote: QUOTE,
            anchorRect,
            creation,
          }
        : {
            kind: "existing",
            highlightId: HIGHLIGHT_ID,
            quote: QUOTE,
            note: savedNote,
            anchorRect,
          },
    );
  }

  return (
    <>
      <p ref={passageRef} tabIndex={0}>
        {QUOTE}
      </p>
      <button type="button" onClick={openNote}>
        Reopen annotation
      </button>
      {savedNote ? <p>Saved annotation: {savedNote.body_text}</p> : null}
      {selecting ? (
        <SelectionPopover
          selectionRect={new DOMRect(20, 20, 200, 20)}
          containerRef={passageRef}
          onCreateHighlight={async () => ({ id: HIGHLIGHT_ID })}
          onAddNote={openNote}
          onDismiss={() => setSelecting(false)}
        />
      ) : null}
      <HighlightQuickNoteComposer
        session={session}
        onClose={() => setSession(null)}
        onSaveNote={async (...args) => {
          const saved = await saveHighlightNote(...args);
          setSavedNote(saved);
          return saved;
        }}
        onDeleteNote={deleteHighlightNote}
        onOpenLink={() => {}}
      />
    </>
  );
}

function renderAnnotation({
  viewport = "desktop",
  initiallyOpen = false,
  creation,
}: {
  viewport?: "desktop" | "mobile";
  initiallyOpen?: boolean;
  creation?: Promise<{ id: string } | null>;
} = {}) {
  return render(
    <StrictMode>
      {withRenderEnvironment(
        <FeedbackProvider>
          <ShareControllerProvider>
            <SelectionAnnotation initiallyOpen={initiallyOpen} creation={creation} />
          </ShareControllerProvider>
        </FeedbackProvider>,
        { initialViewport: viewport },
      )}
    </StrictMode>,
  );
}

describe("selection annotation keyboard interaction", () => {
  beforeEach(async () => {
    localStorage.clear();
    await page.viewport(1_024, 768);
  });

  it.each(["desktop", "mobile"] as const)(
    "focuses the annotation textbox after the selection Note action on %s",
    async (viewport) => {
      holdNoteSaves();
      if (viewport === "mobile") await page.viewport(390, 844);
      // A missing overlay history owner must fail without leaving the test frame.
      history.pushState(null, "");
      renderAnnotation({ viewport });
      const passage = screen.getByText(QUOTE);
      passage.focus();
      const range = document.createRange();
      range.selectNodeContents(passage);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);

      await userEvent.click(screen.getByRole("button", { name: "Note" }));

      const textbox = await screen.findByRole("textbox", { name: "Highlight note" });
      await waitFor(() => expect(textbox).toHaveFocus());
      await userEvent.keyboard("Typed without another click");
      expect(textbox).toHaveTextContent("Typed without another click");

      history.back();
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Add note to highlight" })).toBeNull(),
      );
    },
  );

  it("focuses an initially open annotation after strict effect replay", async () => {
    renderAnnotation({ initiallyOpen: true });

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Highlight note" })).toHaveFocus(),
    );
  });

  it("submits on Enter immediately and closes only after the annotation is saved", async () => {
    const pending = holdNoteSaves();
    renderAnnotation();
    await userEvent.click(screen.getByRole("button", { name: "Note" }));
    const textbox = await screen.findByRole("textbox", { name: "Highlight note" });
    // Focus is proved separately; this scenario must reach the Enter regression.
    await userEvent.click(textbox);
    await userEvent.keyboard("Evidence for water");

    await userEvent.keyboard("{Enter}");

    expect(
      pending,
      "Enter must dispatch the current note before the autosave idle timer fires",
    ).toHaveLength(1);
    expect(pending[0]!.body.body_pm_json).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "Evidence for water" }],
    });
    expect(screen.getByRole("dialog", { name: "Add note to highlight" })).toBeVisible();
    expect(textbox).toHaveFocus();

    acceptSave(pending[0]!, "Evidence for water");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add note to highlight" })).toBeNull(),
    );
    expect(screen.getByText("Saved annotation: Evidence for water")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reopen annotation" }));
    expect(await screen.findByRole("textbox", { name: "Highlight note" })).toHaveTextContent(
      "Evidence for water",
    );
  });

  it("submits a fresh selection only after its highlight exists and closes after the note is saved", async () => {
    const pending = holdNoteSaves();
    let acceptHighlight!: (highlight: { id: string }) => void;
    const creation = new Promise<{ id: string }>((resolve) => {
      acceptHighlight = resolve;
    });
    renderAnnotation({ creation });
    await userEvent.click(screen.getByRole("button", { name: "Note" }));
    const textbox = await screen.findByRole("textbox", { name: "Highlight note" });
    await waitFor(() => expect(textbox).toHaveFocus());
    await userEvent.keyboard("Captured before highlight creation{Enter}");

    expect(
      pending,
      "a selection note cannot be written before its highlight has an identity",
    ).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "Add note to highlight" })).toBeVisible();
    expect(textbox).toHaveTextContent("Captured before highlight creation");

    acceptHighlight({ id: HIGHLIGHT_ID });

    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]!.body.body_pm_json).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "Captured before highlight creation" }],
    });
    expect(screen.getByRole("dialog", { name: "Add note to highlight" })).toBeVisible();
    expect(textbox).toHaveFocus();
    acceptSave(pending[0]!, "Captured before highlight creation");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add note to highlight" })).toBeNull(),
    );
    expect(screen.getByText("Saved annotation: Captured before highlight creation")).toBeVisible();
  });

  it("retains a pending note when its highlight was not created", async () => {
    const pending = holdNoteSaves();
    // A modeled failure must retain the note even when the real defect boundary exists.
    render(
      <DefectBoundary>
        <StrictMode>
          {withRenderEnvironment(
            <FeedbackProvider>
              <ShareControllerProvider>
                <SelectionAnnotation creation={Promise.resolve(null)} />
              </ShareControllerProvider>
            </FeedbackProvider>,
          )}
        </StrictMode>
      </DefectBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Note" }));
    const textbox = await screen.findByRole("textbox", { name: "Highlight note" });
    await userEvent.click(textbox);
    await userEvent.keyboard("Keep this unsaved observation{Enter}");

    expect(await screen.findByText("Highlight wasn’t created")).toBeVisible();
    expect(textbox).toHaveTextContent("Keep this unsaved observation");
    expect(textbox).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Add note to highlight" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Discard" })).toBeVisible();
    expect(pending, "a missing highlight cannot own a note write").toHaveLength(0);
  });

  it("routes an unexpected highlight creation rejection to the defect boundary", async () => {
    holdNoteSaves();
    let rejectCreation!: (error: unknown) => void;
    const creation = new Promise<{ id: string } | null>((_resolve, reject) => {
      rejectCreation = reject;
    });
    render(
      <DefectBoundary>
        <StrictMode>
          {withRenderEnvironment(
            <FeedbackProvider>
              <ShareControllerProvider>
                <SelectionAnnotation creation={creation} />
              </ShareControllerProvider>
            </FeedbackProvider>,
          )}
        </StrictMode>
      </DefectBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Note" }));
    const textbox = await screen.findByRole("textbox", { name: "Highlight note" });
    await userEvent.click(textbox);
    await userEvent.keyboard("Trigger the true defect{Enter}");

    rejectCreation(new Error("synthetic highlight creation defect"));

    expect(await screen.findByText("Annotation defect")).toBeVisible();
  });

  it("keeps Shift+Enter as a newline and composition Enter out of submission", async () => {
    const pending = holdNoteSaves();
    renderAnnotation();
    await userEvent.click(screen.getByRole("button", { name: "Note" }));
    const textbox = await screen.findByRole("textbox", { name: "Highlight note" });
    await userEvent.click(textbox);
    await userEvent.keyboard("First{Shift>}{Enter}{/Shift}Second");
    fireEvent.compositionStart(textbox);
    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter", isComposing: true });
    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter", keyCode: 229 });
    fireEvent.compositionEnd(textbox);

    expect(
      pending,
      "newlines and composition confirmation must not submit the annotation",
    ).toHaveLength(0);
    expect(textbox).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Add note to highlight" })).toBeVisible();

    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" });

    expect(pending).toHaveLength(1);
    expect(pending[0]!.body.body_pm_json).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "First" },
        { type: "hard_break" },
        { type: "text", text: "Second" },
      ],
    });
    acceptSave(pending[0]!, "First\nSecond");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add note to highlight" })).toBeNull(),
    );
  });

  it("retains the annotation after a failed submission and saves it on a fresh Enter", async () => {
    const pending = holdNoteSaves();
    renderAnnotation();
    await userEvent.click(screen.getByRole("button", { name: "Note" }));
    const textbox = await screen.findByRole("textbox", { name: "Highlight note" });
    await userEvent.click(textbox);
    await userEvent.keyboard("Keep this observation");
    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" });
    expect(pending).toHaveLength(1);

    pending[0]!.resolve(
      new Response(
        JSON.stringify({
          error: {
            code: "E_UPSTREAM_TIMEOUT",
            message: "The save timed out",
            request_id: "annotation-save-timeout",
          },
        }),
        { status: 504, headers: { "Content-Type": "application/json" } },
      ),
    );

    expect(
      await screen.findByText("Highlight note wasn’t saved"),
    ).toBeVisible();
    expect(textbox).toHaveTextContent("Keep this observation");
    expect(textbox).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Add note to highlight" })).toBeVisible();

    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" });

    expect(pending).toHaveLength(2);
    expect(pending[1]!.body).toEqual(pending[0]!.body);
    acceptSave(pending[1]!, "Keep this observation");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add note to highlight" })).toBeNull(),
    );
    expect(screen.getByText("Saved annotation: Keep this observation")).toBeVisible();
  });

  it("keeps editing when text changes during submission and saves the newer text on Enter", async () => {
    const pending = holdNoteSaves();
    renderAnnotation();
    await userEvent.click(screen.getByRole("button", { name: "Note" }));
    const textbox = await screen.findByRole("textbox", { name: "Highlight note" });
    await userEvent.click(textbox);
    await userEvent.keyboard("First thought");
    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" });
    expect(pending).toHaveLength(1);
    await userEvent.keyboard(", revised");

    acceptSave(pending[0]!, "First thought");

    expect(await screen.findByText("Saved annotation: First thought")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Add note to highlight" })).toBeVisible();
    expect(textbox).toHaveTextContent("First thought, revised");
    expect(textbox).toHaveFocus();
    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" });

    expect(pending).toHaveLength(2);
    expect(pending[1]!.body.body_pm_json).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "First thought, revised" }],
    });
    acceptSave(pending[1]!, "First thought, revised");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add note to highlight" })).toBeNull(),
    );
    expect(screen.getByText("Saved annotation: First thought, revised")).toBeVisible();
  });

  it("keeps ordinary inline highlight notes multiline on Enter", async () => {
    const pending = holdNoteSaves();
    render(
      <FeedbackProvider>
        <HighlightNoteEditor
          highlightId={HIGHLIGHT_ID}
          note={null}
          editable
          onSave={saveHighlightNote}
          onDelete={deleteHighlightNote}
          onOpenLink={() => {}}
        />
        <button type="button">Leave inline note</button>
      </FeedbackProvider>,
    );
    const textbox = screen.getByRole("textbox", { name: "Highlight note" });
    await userEvent.click(textbox);
    await userEvent.keyboard("First{Enter}Second");
    expect(pending).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Leave inline note" }));

    expect(pending).toHaveLength(1);
    expect(pending[0]!.body.body_pm_json).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "First" },
        { type: "hard_break" },
        { type: "text", text: "Second" },
      ],
    });
    acceptSave(pending[0]!, "First\nSecond");
    expect(textbox).toHaveTextContent("FirstSecond");
  });
});
