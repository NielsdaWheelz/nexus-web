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
                  existing_link_id: null,
                },
              ],
              next_cursor: null,
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
      resource_ref: ref,
      kind: "route",
      href: "/pages/55555555-5555-4555-8555-555555555555",
      unresolved_reason: null,
    },
    missing: false,
    capabilities: {
      user_relation: {
        user_link_source: true,
        user_link_target: "direct",
        note_reference_target: true,
      },
      sharing: "None",
      libraryPlacement: "None",
      attachable: false,
      chat_subject: "none",
      readable: "none",
      inspectable: "none",
      citable_result_type: null,
      citation_output_source: false,
      app_search_scope: true,
      conversation_search_scope: false,
      prompt_render: "none",
      expansion_policy: "none",
      expandable: false,
      adjacency_source: true,
      adjacency_target: true,
    },
    version_by_lane: {},
  };
}
