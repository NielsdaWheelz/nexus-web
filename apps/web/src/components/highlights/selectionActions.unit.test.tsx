import { describe, expect, it } from "vitest";
import type { PaneHeaderAction } from "@/lib/ui/actionDescriptor";
import {
  buildSelectionActions,
  projectSelectionActionPlan,
} from "./selectionActions";

const noop = () => {};

function selectionActions({
  canQuoteToChat = true,
  canAddNote = true,
  changingColor = false,
}: {
  canQuoteToChat?: boolean;
  canAddNote?: boolean;
  changingColor?: boolean;
} = {}): PaneHeaderAction[] {
  return buildSelectionActions({
    color: "yellow",
    canQuoteToChat,
    canAddNote,
    changingColor,
    handlers: {
      onSelectColor: noop,
      onAddNote: canAddNote ? noop : undefined,
      onLink: noop,
      onShare: noop,
      onLearn: noop,
      onQuoteToNewChat: canQuoteToChat ? noop : undefined,
      onQuoteToExistingChat: canQuoteToChat ? noop : undefined,
    },
  });
}

function byId(actions: readonly PaneHeaderAction[], id: string) {
  const action = actions.find((candidate) => candidate.id === id);
  if (!action) throw new Error(`Selection action omitted ${id}`);
  return action;
}

describe("fresh-selection action plan", () => {
  it("projects the fixed direct and overflow tiers", () => {
    const plan = projectSelectionActionPlan(selectionActions());
    expect(plan.direct.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "color", label: "Highlight" },
      { id: "note", label: "Note" },
      { id: "link", label: "Link" },
      { id: "quote-new", label: "Ask" },
    ]);
    expect(plan.overflow.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "learn", label: "Learn" },
      { id: "quote-existing", label: "Ask in existing chat…" },
      { id: "share", label: "Share" },
    ]);
  });

  it("orders by the selection contract, not emission order", () => {
    const actions = selectionActions();
    const shuffled = [
      "quote-existing",
      "link",
      "share",
      "color",
      "learn",
      "quote-new",
      "note",
    ].map((id) => byId(actions, id));
    const plan = projectSelectionActionPlan(shuffled);
    expect([
      plan.direct.map((action) => action.id),
      plan.overflow.map((action) => action.id),
    ]).toEqual([
      ["color", "note", "link", "quote-new"],
      ["learn", "quote-existing", "share"],
    ]);
  });

  it("drops unavailable controls without promoting tiers", () => {
    const plan = projectSelectionActionPlan(
      selectionActions({ canQuoteToChat: false, canAddNote: false }),
    );
    expect(plan.direct.map((action) => action.id)).toEqual(["color", "link"]);
    expect(plan.overflow.map((action) => action.id)).toEqual([
      "learn",
      "share",
    ]);
  });

  it("preserves descriptors and creation-busy state", () => {
    const actions = selectionActions({ changingColor: true });
    const plan = projectSelectionActionPlan(actions);
    const projected = [...plan.direct, ...plan.overflow];
    expect(projected.every((action) => actions.includes(action))).toBe(true);
    expect(projected.every((action) => action.disabled === true)).toBe(true);
  });

  it("rejects duplicate and unclassified ids", () => {
    const actions = selectionActions();
    expect(() =>
      projectSelectionActionPlan([...actions, byId(actions, "color")]),
    ).toThrow(/Duplicate.*color/);
    expect(() =>
      projectSelectionActionPlan([
        ...actions,
        {
          kind: "command",
          id: "standing-resource-action",
          label: "Forbidden",
          icon: byId(actions, "color").icon,
          onSelect: noop,
        },
      ]),
    ).toThrow(/Unclassified.*standing-resource-action/);
  });
});
