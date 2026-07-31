import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { paragraphFromText } from "@/lib/notes/prosemirror/schema";
import NoteBodyEditor from "./NoteBodyEditor";

describe("NoteBodyEditor", () => {
  it("splits on Enter while Shift+Enter remains an inline hard break", async () => {
    const onSplit = vi.fn();
    const onBodyChange = vi.fn();
    render(
      <NoteBodyEditor
        resourceKey="note:split"
        initialBodyPmJson={paragraphFromText("hello").toJSON()}
        ariaLabel="Editable note"
        onSplit={onSplit}
        onBodyChange={onBodyChange}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Editable note" });
    await userEvent.click(editor);
    await userEvent.keyboard("{End}{Enter}");
    expect(onSplit).toHaveBeenCalledWith(
      expect.objectContaining({
        leftBodyText: "hello",
        rightBodyText: "",
      }),
    );

    onSplit.mockClear();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSplit).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onBodyChange).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyPmJson: expect.objectContaining({
            type: "paragraph",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "hard_break" }),
            ]),
          }),
        }),
      );
    });
  });

  it("gives IME composition precedence over structural Enter", async () => {
    const onSplit = vi.fn();
    render(
      <NoteBodyEditor
        resourceKey="note:ime"
        initialBodyPmJson={paragraphFromText("compose").toJSON()}
        ariaLabel="Composing note"
        onSplit={onSplit}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Composing note" });
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(onSplit).not.toHaveBeenCalled();
  });

  it("unlinks only an empty body and exposes keyboard reorder", async () => {
    const onEmptyBackspace = vi.fn();
    const onMove = vi.fn();
    render(
      <NoteBodyEditor
        resourceKey="note:keys"
        initialBodyPmJson={paragraphFromText("").toJSON()}
        ariaLabel="Empty note"
        onEmptyBackspace={onEmptyBackspace}
        onMove={onMove}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Empty note" });
    await userEvent.click(editor);
    await userEvent.keyboard("{Backspace}{Alt>}{ArrowDown}{/Alt}");
    expect(onEmptyBackspace).toHaveBeenCalledOnce();
    expect(onMove).toHaveBeenCalledWith("down");
  });

  it("activates embedded references with a semantic label", async () => {
    const onOpenObject = vi.fn();
    render(
      <NoteBodyEditor
        resourceKey="note:reference"
        initialBodyPmJson={{
          type: "paragraph",
          content: [
            {
              type: "object_ref",
              attrs: {
                objectType: "page",
                objectId: "11111111-1111-4111-8111-111111111111",
                label: "Project",
              },
            },
          ],
        }}
        onOpenObject={onOpenObject}
      />,
    );
    await userEvent.click(screen.getByRole("link", { name: "Open Project" }));
    expect(onOpenObject).toHaveBeenCalledWith(
      "page",
      "11111111-1111-4111-8111-111111111111",
      { kind: "Follow" },
    );
  });

  it("reloads external body content in place without rebuilding the editor", async () => {
    const { rerender } = render(
      <NoteBodyEditor
        resourceKey="note:reload"
        initialBodyPmJson={paragraphFromText("Local").toJSON()}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Note content" });
    await userEvent.click(editor);

    rerender(
      <NoteBodyEditor
        resourceKey="note:reload"
        initialBodyPmJson={paragraphFromText("Reloaded").toJSON()}
        ariaLabel="Canonical note"
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "Canonical note" }),
    ).toBe(editor);
    expect(editor).toHaveTextContent("Reloaded");
    expect(editor).toHaveFocus();
  });

  it("claims completed composition from canonical PM state and keeps selection for following typing", async () => {
    const onBodyChange = vi.fn();
    const onInputHandoffClaimed = vi.fn();
    const composing = {
      handoffId: "handoff-1",
      text: "Buffered",
      selectionStart: 4,
      selectionEnd: 4,
      composition: "Composing" as const,
    };
    const { rerender } = render(
      <NoteBodyEditor
        resourceKey="note:handoff"
        initialBodyPmJson={paragraphFromText("").toJSON()}
        ariaLabel="Handoff note"
        inputHandoff={composing}
        onBodyChange={onBodyChange}
        onInputHandoffClaimed={onInputHandoffClaimed}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Handoff note" });
    expect(onInputHandoffClaimed).not.toHaveBeenCalled();

    rerender(
      <NoteBodyEditor
        resourceKey="note:handoff"
        initialBodyPmJson={paragraphFromText("Buffered").toJSON()}
        ariaLabel="Handoff note"
        inputHandoff={{ ...composing, composition: "Complete" }}
        onBodyChange={onBodyChange}
        onInputHandoffClaimed={onInputHandoffClaimed}
      />,
    );

    await waitFor(() =>
      expect(onInputHandoffClaimed).toHaveBeenCalledWith("handoff-1"),
    );
    expect(onInputHandoffClaimed).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Handoff note" })).toBe(editor);
    expect(editor).toHaveTextContent("Buffered");
    expect(editor).toHaveFocus();
    expect(window.getSelection()?.anchorOffset).toBe(4);

    await userEvent.keyboard("X");
    await waitFor(() =>
      expect(onBodyChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ bodyText: "BuffXered" }),
      ),
    );
    expect(onInputHandoffClaimed).toHaveBeenCalledOnce();
    expect(editor).toHaveTextContent("BuffXered");
  });

  it("preserves marked and object PM JSON while claiming a recovered handoff", async () => {
    const richBody = {
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
    const onBodyChange = vi.fn();
    render(
      <NoteBodyEditor
        resourceKey="note:rich-handoff"
        initialBodyPmJson={richBody}
        ariaLabel="Rich handoff"
        inputHandoff={{
          handoffId: "handoff-rich",
          text: "BoldProject",
          selectionStart: 4,
          selectionEnd: 4,
          composition: "Complete",
        }}
        onBodyChange={onBodyChange}
        onInputHandoffClaimed={vi.fn()}
      />,
    );

    await waitFor(() => expect(onBodyChange).toHaveBeenCalled());
    expect(onBodyChange.mock.calls[0]?.[0]?.bodyPmJson).toEqual(richBody);
    expect(screen.getByText("Bold").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "Open Project" })).toBeVisible();
  });

  it("leaves Tab and modified Enter to focus and line-break behavior while autocomplete is open", async () => {
    const onBodyChange = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        new Response(
          JSON.stringify({
            data: {
              targets: [
                {
                  kind: "resource",
                  item: referenceTargetItem(),
                  existingLinkId: null,
                },
              ],
              nextCursor: null,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    try {
      render(
        <NoteBodyEditor
          resourceKey="note:autocomplete-precedence"
          initialBodyPmJson={paragraphFromText("").toJSON()}
          onBodyChange={onBodyChange}
        />,
      );
      const editor = screen.getByRole("textbox", { name: "Note content" });
      await userEvent.click(editor);
      await userEvent.keyboard("@Proj");
      await screen.findByRole("listbox", { name: "Object references" });

      expect(fireEvent.keyDown(editor, { key: "Tab" })).toBe(true);
      fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
      await waitFor(() => {
        expect(onBodyChange).toHaveBeenCalledWith(
          expect.objectContaining({
            bodyPmJson: expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({ type: "hard_break" }),
              ]),
            }),
          }),
        );
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

function referenceTargetItem() {
  const ref = "page:55555555-5555-4555-8555-555555555555";
  return {
    ref,
    scheme: "page",
    id: "55555555-5555-4555-8555-555555555555",
    label: "Project",
    summary: "",
    route: "/pages/55555555-5555-4555-8555-555555555555",
    activation: {
      resourceRef: ref,
      kind: "route",
      href: "/pages/55555555-5555-4555-8555-555555555555",
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: {
        userLinkSource: true,
        userLinkTarget: "direct",
        noteReferenceTarget: true,
      },
      sharing: "None",
      libraryPlacement: "None",
      attachable: false,
      chatSubject: "none",
      readable: "none",
      inspectable: "none",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: true,
      conversationSearchScope: false,
      promptRender: "none",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: {},
  };
}
