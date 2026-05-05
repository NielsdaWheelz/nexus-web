import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { outlineSchema } from "@/lib/notes/prosemirror/schema";
import type { HydratedObjectRef } from "@/lib/objectRefs";
import ProseMirrorOutlineEditor from "./ProseMirrorOutlineEditor";

describe("ProseMirrorOutlineEditor object refs", () => {
  it("opens focused object refs from the keyboard", async () => {
    const objectId = "11111111-1111-4111-8111-111111111111";
    const onOpenObject = vi.fn();

    render(<ProseMirrorOutlineEditor doc={noteDoc(objectId)} onOpenObject={onOpenObject} />);

    const objectRef = await screen.findByRole("link", { name: "Open Source media" });
    objectRef.focus();
    fireEvent.keyDown(objectRef, { key: "Enter", shiftKey: true });

    expect(onOpenObject).toHaveBeenCalledWith("media", objectId, true);
  });

  it("inserts object refs from @ autocomplete", async () => {
    const user = userEvent.setup();
    const objectId = "22222222-2222-4222-8222-222222222222";
    const searchObjects = vi.fn(async (): Promise<HydratedObjectRef[]> => [
      {
        objectType: "media",
        objectId,
        label: "Evergreen Source",
        route: `/media/${objectId}`,
      },
    ]);

    render(<ProseMirrorOutlineEditor doc={emptyDoc()} searchObjects={searchObjects} />);

    const editor = screen.getByRole("textbox", { name: "Notes outline" });
    await user.click(editor);
    await user.keyboard("@Evergreen");
    const option = await screen.findByRole("button", { name: /Evergreen Source/ });
    await user.click(option);

    await screen.findByRole("link", { name: "Open Evergreen Source" });
    await waitFor(() => {
      expect(searchObjects).toHaveBeenLastCalledWith("Evergreen");
    });
  });

  it("inserts page and note refs from [[ autocomplete", async () => {
    const user = userEvent.setup();
    const pageId = "44444444-4444-4444-8444-444444444444";
    const noteBlockId = "55555555-5555-4555-8555-555555555555";
    const mediaId = "66666666-6666-4666-8666-666666666666";
    const searchObjects = vi.fn(async (): Promise<HydratedObjectRef[]> => [
      {
        objectType: "media",
        objectId: mediaId,
        label: "Evergreen Media",
        route: `/media/${mediaId}`,
      },
      {
        objectType: "page",
        objectId: pageId,
        label: "Evergreen Page",
        route: `/pages/${pageId}`,
      },
      {
        objectType: "note_block",
        objectId: noteBlockId,
        label: "Evergreen Note",
        route: `/notes/${noteBlockId}`,
      },
    ]);

    render(<ProseMirrorOutlineEditor doc={emptyDoc()} searchObjects={searchObjects} />);

    const editor = screen.getByRole("textbox", { name: "Notes outline" });
    await user.click(editor);
    await user.keyboard("[[[[Evergreen");
    const option = await screen.findByRole("button", { name: /Evergreen Page/ });

    expect(screen.queryByRole("button", { name: /Evergreen Media/ })).toBeNull();

    await user.click(option);

    await screen.findByRole("link", { name: "Open Evergreen Page" });
    await waitFor(() => {
      expect(searchObjects).toHaveBeenLastCalledWith("Evergreen");
    });
  });

  it("opens object ref autocomplete for selected text with Mod+K", async () => {
    const user = userEvent.setup();
    const objectId = "33333333-3333-4333-8333-333333333333";
    const searchObjects = vi.fn(async (): Promise<HydratedObjectRef[]> => [
      {
        objectType: "page",
        objectId,
        label: "Evergreen Page",
        route: `/pages/${objectId}`,
      },
    ]);

    render(<ProseMirrorOutlineEditor doc={emptyDoc()} searchObjects={searchObjects} />);

    const editor = screen.getByRole("textbox", { name: "Notes outline" });
    await user.click(editor);
    await user.keyboard("Evergreen");
    await user.keyboard("{Shift>}");
    for (let index = 0; index < "Evergreen".length; index += 1) {
      await user.keyboard("{ArrowLeft}");
    }
    await user.keyboard("{/Shift}");

    fireEvent.keyDown(editor, { key: "k", metaKey: true });
    const option = await screen.findByRole("button", { name: /Evergreen Page/ });
    await user.click(option);

    await screen.findByRole("link", { name: "Open Evergreen Page" });
    await waitFor(() => {
      expect(searchObjects).toHaveBeenLastCalledWith("Evergreen");
    });
  });
});

function noteDoc(objectId: string) {
  const paragraph = outlineSchema.nodes.paragraph!.create(null, [
    outlineSchema.text("See "),
    outlineSchema.nodes.object_ref!.create({
      objectType: "media",
      objectId,
      label: "Source media",
    }),
  ]);
  const block = outlineSchema.nodes.outline_block!.create(
    { id: "block-1", kind: "bullet", collapsed: false },
    [paragraph]
  );
  return outlineSchema.nodes.outline_doc!.create(null, [block]);
}

function emptyDoc() {
  const paragraph = outlineSchema.nodes.paragraph!.create();
  const block = outlineSchema.nodes.outline_block!.create(
    { id: "block-1", kind: "bullet", collapsed: false },
    [paragraph]
  );
  return outlineSchema.nodes.outline_doc!.create(null, [block]);
}
