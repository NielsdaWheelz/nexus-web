import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import type {
  ResourceItem,
  ResourceSurfaceOccurrence,
} from "@/lib/resources/resourceItems";
import ResourceSurfaceBodyEditor from "./ResourceSurfaceBodyEditor";

describe("ResourceSurfaceBodyEditor", () => {
  it("renders a flat mixed-resource body with semantic controls", async () => {
    const onActivate = vi.fn();
    const onInsertNote = vi.fn();
    const onRemoveOccurrence = vi.fn();
    const onMoveOccurrence = vi.fn();
    const items = [
      noteOccurrence("occ-note", "First note"),
      resourceOccurrence("occ-media", "Paper"),
    ];

    renderEditor(items, {
      onActivate,
      onInsertNote,
      onRemoveOccurrence,
      onMoveOccurrence,
    });

    expect(
      screen.getByRole("region", { name: "Ordered resources" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Edit note 1" }),
    ).toHaveTextContent("First note");
    await userEvent.click(screen.getByRole("button", { name: "Open Paper" }));
    expect(onActivate).toHaveBeenCalledWith(items[1]!.target.item, false);

    await userEvent.click(screen.getByRole("button", { name: "Add a note" }));
    expect(onInsertNote).toHaveBeenCalledWith({
      kind: "after",
      occurrenceId: "occ-media",
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Paper" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Move Paper earlier" }),
    );
    expect(onMoveOccurrence).toHaveBeenCalledWith({
      occurrenceId: "occ-media",
      position: { kind: "start" },
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Paper" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", {
        name: "Remove Paper from this surface",
      }),
    );
    expect(onRemoveOccurrence).toHaveBeenCalledWith("occ-media");
  });

  it("keeps the empty insertion row flat and ignores Shift+Enter", async () => {
    const onInsertNote = vi.fn();
    renderEditor([], { onInsertNote });
    const insertion = screen.getByRole("button", { name: "Add a note" });
    insertion.focus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onInsertNote).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onInsertNote).toHaveBeenCalledWith({ kind: "start" });
  });

  it("keeps a newly inserted note focused when its occurrence becomes canonical", async () => {
    const optimistic = noteOccurrence(
      "local:22222222-2222-4222-8222-222222222222",
      "",
    );
    const view = renderEditor([optimistic], {
      focusRequest: {
        occurrenceId: optimistic.occurrenceId,
        serial: 1,
      },
    });
    const editor = screen.getByRole("textbox", { name: "Edit note 1" });
    await vi.waitFor(() => expect(editor).toHaveFocus());

    view.rerender(
      withRenderEnvironment(
        <ResourceSurfaceBodyEditor
          sourceRef="page:11111111-1111-4111-8111-111111111111"
          orderedItems={[noteOccurrence("canonical-edge", "")]}
          focusRequest={{
            occurrenceId: optimistic.occurrenceId,
            serial: 1,
          }}
          onInsertNote={vi.fn()}
          onSplitNote={vi.fn()}
          onMoveOccurrence={vi.fn()}
          onRemoveOccurrence={vi.fn()}
          onInsertResource={vi.fn()}
          onBodyChange={vi.fn()}
          onBodyBlur={vi.fn()}
          onActivate={vi.fn()}
        />,
      ),
    );

    expect(screen.getByRole("textbox", { name: "Edit note 1" })).toBe(editor);
    expect(editor).toHaveFocus();
  });

  it("supports keyboard-only resource insertion through the shared listbox", async () => {
    const onInsertResource = vi.fn();
    const target = resourceItem(
      "media:33333333-3333-4333-8333-333333333333",
      "Paper",
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            targets: [
              { kind: "resource", item: target, existing_link_id: null },
            ],
            next_cursor: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      renderEditor([], { onInsertResource });
      await userEvent.click(screen.getByRole("button", { name: "Add item" }));
      const search = screen.getByRole("combobox", { name: "Add item" });
      await userEvent.type(search, "Paper");
      await screen.findByRole("option", { name: /Paper/ });
      await userEvent.keyboard("{Enter}");

      expect(onInsertResource).toHaveBeenCalledWith({
        targetRef: target.ref,
        position: { kind: "start" },
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

function renderEditor(
  orderedItems: ResourceSurfaceOccurrence[],
  overrides: Partial<
    React.ComponentProps<typeof ResourceSurfaceBodyEditor>
  > = {},
) {
  return render(
    withRenderEnvironment(
      <ResourceSurfaceBodyEditor
        sourceRef="page:11111111-1111-4111-8111-111111111111"
        orderedItems={orderedItems}
        onInsertNote={vi.fn()}
        onSplitNote={vi.fn()}
        onMoveOccurrence={vi.fn()}
        onRemoveOccurrence={vi.fn()}
        onInsertResource={vi.fn()}
        onBodyChange={vi.fn()}
        onBodyBlur={vi.fn()}
        onActivate={vi.fn()}
        {...overrides}
      />,
    ),
  );
}

function noteOccurrence(
  occurrenceId: string,
  text: string,
): ResourceSurfaceOccurrence {
  return {
    occurrenceId,
    target: {
      item: resourceItem(
        `note_block:22222222-2222-4222-8222-222222222222`,
        "First note",
      ),
      content: {
        kind: "note_body",
        bodyPmJson: {
          type: "paragraph",
          content: [{ type: "text", text }],
        },
        bodyText: text,
      },
    },
  };
}

function resourceOccurrence(
  occurrenceId: string,
  label: string,
): ResourceSurfaceOccurrence {
  return {
    occurrenceId,
    target: {
      item: resourceItem(
        "media:33333333-3333-4333-8333-333333333333",
        label,
      ),
      content: { kind: "resource_summary" },
    },
  };
}

function resourceItem(ref: string, label: string): ResourceItem {
  const [scheme, id] = ref.split(":") as [string, string];
  return {
    ref,
    scheme,
    id,
    label,
    summary: `${label} summary`,
    route: `/${scheme}/${id}`,
    activation: {
      resourceRef: ref,
      kind: "route",
      href: `/${scheme}/${id}`,
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
      adjacencySource: scheme === "note_block",
      adjacencyTarget: true,
    },
    versionByLane: {},
  };
}
