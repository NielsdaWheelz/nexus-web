import { describe, expect, it } from "vitest";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import type { PaneHeaderAction } from "@/lib/ui/actionDescriptor";
import {
  buildHighlightActions,
  projectSelectionActionPlan,
} from "./highlightActions";

/**
 * Oracle: `docs/cutovers/text-selection-icon-toolbar-hard-cutover.md` §4.1
 * (canonical tier/id/label table), §6.1 (projector laws) and §9 AC1/AC2/AC9.
 * Nothing here is derived from the current renderer.
 */

const IDLE = {
  isEditingBounds: false,
  deleting: false,
  changingColor: false,
};
const noop = () => {};

const EXISTING_HIGHLIGHT: AnchoredReaderRow = {
  id: "0f2ad0f6-0000-4000-8000-000000000001",
  exact: "water ice at the lunar south pole",
  color: "yellow",
  is_owner: true,
};

function selectionCatalog({
  canQuoteToChat = true,
  canAddNote = true,
  changingColor = false,
}: {
  canQuoteToChat?: boolean;
  canAddNote?: boolean;
  changingColor?: boolean;
} = {}): PaneHeaderAction[] {
  return buildHighlightActions({
    target: { kind: "selection", color: "yellow" },
    canQuoteToChat,
    canAddNote,
    isReflowable: false,
    state: { ...IDLE, changingColor },
    handlers: {
      onSelectColor: noop,
      onAddNote: canAddNote ? noop : undefined,
      onLink: noop,
      onShare: noop,
      onLearn: noop,
      onQuoteToNewChat: canQuoteToChat ? noop : undefined,
      onQuoteToExistingChat: canQuoteToChat ? noop : undefined,
      onToggleEditBounds: noop,
      onDelete: noop,
    },
  });
}

function existingHighlightCatalog(): PaneHeaderAction[] {
  return buildHighlightActions({
    target: { kind: "existing", highlight: EXISTING_HIGHLIGHT },
    canQuoteToChat: true,
    canAddNote: true,
    isReflowable: true,
    state: IDLE,
    handlers: {
      onSelectColor: noop,
      onAddNote: noop,
      onLink: noop,
      onShare: noop,
      onLearn: noop,
      onQuoteToNewChat: noop,
      onQuoteToExistingChat: noop,
      onToggleEditBounds: noop,
      onDelete: noop,
    },
  });
}

function named(actions: readonly PaneHeaderAction[]) {
  return actions.map(({ id, label }) => ({ id, label }));
}

function byId(
  actions: readonly PaneHeaderAction[],
  id: string,
): PaneHeaderAction {
  const action = actions.find((candidate) => candidate.id === id);
  if (!action) {
    throw new Error(
      `Catalog omitted ${id}; available ids: ${actions.map((a) => a.id).join(", ")}`,
    );
  }
  return action;
}

describe("fresh-selection action plan", () => {
  it("projects the canonical direct row and overflow menu for a full-capability selection", () => {
    const plan = projectSelectionActionPlan(selectionCatalog());

    expect(
      named(plan.direct),
      "AC1: the direct row must be exactly Highlight, Note, Link, Ask (spec §4.1)",
    ).toEqual([
      { id: "color", label: "Highlight" },
      { id: "note", label: "Note" },
      { id: "link", label: "Link" },
      { id: "quote-new", label: "Ask" },
    ]);
    expect(
      named(plan.overflow),
      "AC2: the overflow menu must be exactly Learn, Ask in existing chat…, Share (spec §4.1)",
    ).toEqual([
      { id: "learn", label: "Learn" },
      { id: "quote-existing", label: "Ask in existing chat…" },
      { id: "ResourceAction.Share", label: "Share" },
    ]);
  });

  it("emits the canonical order no matter what order the catalog emitted", () => {
    const catalog = selectionCatalog();
    const shuffled = [
      "quote-existing",
      "link",
      "ResourceAction.Share",
      "color",
      "learn",
      "quote-new",
      "note",
    ].map((id) => byId(catalog, id));

    const plan = projectSelectionActionPlan(shuffled);

    expect(
      [plan.direct.map((a) => a.id), plan.overflow.map((a) => a.id)],
      "spec §6.1: tier order is fixed data, not a function of catalog emission order",
    ).toEqual([
      ["color", "note", "link", "quote-new"],
      ["learn", "quote-existing", "ResourceAction.Share"],
    ]);
  });

  it("drops ineligible actions without promoting an overflow action into the direct row", () => {
    const plan = projectSelectionActionPlan(
      selectionCatalog({ canQuoteToChat: false, canAddNote: false }),
    );

    expect(
      plan.direct.map((a) => a.id),
      "spec §4.1 rule 3: survivors keep their relative slots when Note and Ask are ineligible",
    ).toEqual(["color", "link"]);
    expect(
      plan.overflow.map((a) => a.id),
      "spec §4.1 rule 3: a shorter direct row must not pull Learn or Share out of overflow",
    ).toEqual(["learn", "ResourceAction.Share"]);
  });

  it("carries every descriptor's disabled state, glyph and behaviour through the partition", () => {
    const catalog = selectionCatalog({ changingColor: true });
    const plan = projectSelectionActionPlan(catalog);
    const projected = [...plan.direct, ...plan.overflow];

    expect(
      projected.map((a) => a.id).sort(),
      "the projection invented or dropped an action relative to the catalog",
    ).toEqual(catalog.map((a) => a.id).sort());

    expect(
      projected
        .filter((action) => !catalog.includes(action))
        .map((action) => action.id),
      "spec §6.1: every projected descriptor must be the catalog's own object, so its glyph, tone, custom renderer and handler cannot be rebuilt in the partition",
    ).toEqual([]);

    for (const action of projected) {
      expect(
        action.disabled,
        `${action.id} lost the in-flight highlight-creation disabled state (spec §4.1 rule 2)`,
      ).toBe(true);
    }
  });

  it("carries no Passage Palette separator into either tier", () => {
    const plan = projectSelectionActionPlan(selectionCatalog());

    expect(
      [...plan.direct, ...plan.overflow]
        .filter((action) => action.separatorBefore !== undefined)
        .map((action) => action.id),
      "spec §7: the retired palette separator must not survive into the icon toolbar plan",
    ).toEqual([]);
  });

  it("treats a duplicate or unclassified action id as a programmer defect", () => {
    const catalog = selectionCatalog();

    expect(
      () => projectSelectionActionPlan([...catalog, byId(catalog, "color")]),
      "spec §4.1 rule 5: a duplicate id must throw, not be silently de-duplicated",
    ).toThrow(/color/);
    expect(
      () =>
        projectSelectionActionPlan([
          ...catalog,
          byId(existingHighlightCatalog(), "delete"),
        ]),
      "spec §7: an unclassified id must throw, never fall through into More",
    ).toThrow(/delete/);
  });

  it("leaves existing-Highlight descriptors untouched by the fresh-selection cut", () => {
    // AC9: this cut changes fresh-selection presentation only. Chat labels are
    // additionally pinned by docs/modules/highlight.md § Quote-To-Chat.
    expect(
      named(existingHighlightCatalog()),
      "AC9: existing-Highlight ids, labels and order must survive the selection cut",
    ).toEqual([
      { id: "color", label: "Highlight color" },
      { id: "note", label: "Add note" },
      { id: "link", label: "Link…" },
      { id: "ResourceAction.Share", label: "Share…" },
      { id: "learn", label: "Learn" },
      { id: "quote-new", label: "Ask in new chat" },
      { id: "quote-existing", label: "Ask in existing chat…" },
      { id: "edit-bounds", label: "Edit bounds" },
      { id: "delete", label: "Delete highlight" },
    ]);
  });
});
