import { describe, expect, it, vi } from "vitest";
import { buildForkNodeActions } from "./forkNodeActions";

describe("buildForkNodeActions", () => {
  it("builds view actions with stable labels and disabled delete state", () => {
    const onStartRename = vi.fn();
    const onRequestDelete = vi.fn();
    const actions = buildForkNodeActions({
      mode: "view",
      title: "Branch title",
      deleteDisabled: true,
      onStartRename,
      onRequestDelete,
    });

    expect(actions.map((action) => action.id)).toEqual(["rename", "delete"]);
    expect(actions.map((action) => action.label)).toEqual([
      "Rename fork Branch title",
      "Delete fork Branch title",
    ]);
    expect(actions[1]).toMatchObject({ disabled: true });
    expect(actions[1]).not.toHaveProperty("href");
    expect(actions[1]).not.toHaveProperty("render");
    expect(actions[1]).not.toHaveProperty("restoreFocusOnClose");

    actions[0].onSelect?.({ triggerEl: null });
    actions[1].onSelect?.({ triggerEl: null });
    expect(onStartRename).toHaveBeenCalledTimes(1);
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
  });

  it("builds edit actions with stable labels", () => {
    const onSaveRename = vi.fn();
    const onCancelRename = vi.fn();
    const actions = buildForkNodeActions({
      mode: "edit",
      title: "Branch title",
      onSaveRename,
      onCancelRename,
    });

    expect(actions.map((action) => action.id)).toEqual(["save", "cancel"]);
    expect(actions.map((action) => action.label)).toEqual([
      "Save fork Branch title",
      "Cancel rename fork Branch title",
    ]);

    actions[0].onSelect?.({ triggerEl: null });
    actions[1].onSelect?.({ triggerEl: null });
    expect(onSaveRename).toHaveBeenCalledTimes(1);
    expect(onCancelRename).toHaveBeenCalledTimes(1);
  });
});
