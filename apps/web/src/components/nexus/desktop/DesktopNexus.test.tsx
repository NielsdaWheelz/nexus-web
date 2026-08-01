import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  NexusAction,
  NexusEntry,
  NexusEntryKey,
  NexusGroup,
  NexusIcon,
  NexusProjection,
} from "@/lib/nexus/model";
import DesktopNexus from "./DesktopNexus";
import type { DesktopNexusController } from "./types";

const FixtureIcon: NexusIcon = (props) => (
  <svg {...props} viewBox="0 0 10 10">
    <circle cx="5" cy="5" r="4" />
  </svg>
);

function action(
  id: string,
  label: string,
  availability: NexusAction["availability"] = {
    kind: "Available",
    target: { kind: "InternalHref", href: `/${id}` },
  },
): NexusAction {
  return {
    id,
    label,
    icon: FixtureIcon,
    activation: { kind: "Standard" },
    availability,
  };
}

function entry(overrides: Partial<NexusEntry> = {}): NexusEntry {
  return {
    key: { kind: "Pane", paneId: "one" },
    historySource: "Workspace",
    label: "Reading notes",
    typeLabel: "Page",
    metadata: "Notes",
    icon: FixtureIcon,
    openState: "Active",
    primaryAction: action("open", "Open"),
    secondaryActions: [action("share", "Share")],
    rank: { tier: "Exact", score: 1, frecency: 1 },
    ...overrides,
  };
}

function group(
  id: NexusGroup["id"],
  label: string,
  entries: readonly NexusEntry[],
  layout: NexusGroup["layout"] = "Flow",
): NexusGroup {
  return { id, label, entries, layout };
}

function projection(
  groups: readonly NexusGroup[],
  activeKey: NexusEntryKey | null = groups[0]?.entries[0]?.key ?? null,
): NexusProjection {
  return { surface: "Desktop", groups, activeKey };
}

function controller(
  overrides: Partial<DesktopNexusController> = {},
): DesktopNexusController {
  const first = entry();
  return {
    open: true,
    projection: projection([group("Results", "Results", [first])]),
    query: "notes",
    failures: new Set(),
    busy: false,
    announcement: null,
    focusKey: "Root",
    nexusOpenShortcutLabel: "Ctrl+K",
    actionsRequest: null,
    setQuery: vi.fn(),
    setActiveEntry: vi.fn(),
    activatePrimary: vi.fn(),
    activateAction: vi.fn(),
    retry: vi.fn(),
    escape: vi.fn(),
    shouldSuppressReturnFocusOnClose: () => false,
    ...overrides,
  };
}

function StatefulDesktopNexus({
  value,
}: {
  value: DesktopNexusController;
}) {
  const [activeKey, setActiveKey] = useState(value.projection.activeKey);
  return (
    <DesktopNexus
      controller={{
        ...value,
        projection: { ...value.projection, activeKey },
        setActiveEntry: (key) => {
          value.setActiveEntry(key);
          setActiveKey(key);
        },
      }}
    />
  );
}

describe("DesktopNexus", () => {
  it("renders owned section order and factual row content in an input-focused grid", async () => {
    const openPane = entry({
      snippetSegments: [
        { text: "A ", emphasized: false },
        { text: "matched", emphasized: true },
        { text: " passage", emphasized: false },
      ],
    });
    const quickAction = entry({
      key: { kind: "QuickAction", actionId: "Nexus.Quick.Page" },
      label: "New Page",
      shortcutHint: "Ctrl+P",
      typeLabel: "Command",
      metadata: undefined,
      openState: undefined,
      secondaryActions: [],
    });
    const value = controller({
      query: "",
      nexusOpenShortcutLabel: "Ctrl+J",
      projection: projection([
        group("Open", "Open", [openPane]),
        group("QuickActions", "Quick Actions", [quickAction]),
      ]),
    });
    render(<DesktopNexus controller={value} />);

    const input = screen.getByRole("combobox", { name: "Find anything…" });
    const grid = screen.getByRole("grid", { name: "Nexus options" });
    await waitFor(() => expect(input).toHaveFocus());

    expect(input).toHaveAttribute("aria-controls", grid.id);
    expect(input).toHaveAttribute("aria-haspopup", "grid");
    expect(
      within(grid)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Open", "Quick Actions"]);
    expect(within(grid).getByRole("rowgroup", { name: "Open" })).toBeVisible();
    expect(
      within(grid).getByRole("gridcell", {
        name: /Reading notes\. Page · Notes · Current\. A matched passage/,
      }),
    ).toBeVisible();
    expect(within(grid).getByText("matched")).toHaveProperty("tagName", "MARK");
    expect(within(grid).getByText("Ctrl+P")).toHaveProperty("tagName", "KBD");

    const actions = within(grid).getByRole("button", {
      name: "Actions for Reading notes",
    });
    expect(actions).toHaveAttribute("tabindex", "-1");
    expect(within(actions).getByText("Ctrl+J")).toHaveProperty("tagName", "KBD");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("keeps DOM focus on the input while arrows move virtual row and cell focus", async () => {
    const user = userEvent.setup();
    const first = entry();
    const second = entry({
      key: { kind: "Pane", paneId: "two" },
      label: "Project notes",
      openState: "Open",
      secondaryActions: [],
    });
    const value = controller({
      projection: projection([group("Results", "Results", [first, second])]),
    });
    render(<StatefulDesktopNexus value={value} />);
    const input = screen.getByRole("combobox", { name: "Find anything…" });
    const firstPrimary = screen.getByRole("gridcell", {
      name: /^Reading notes\./,
    });
    const firstActions = screen.getByRole("gridcell", {
      name: /Actions for Reading notes/,
    });
    const secondPrimary = screen.getByRole("gridcell", {
      name: /Project notes/,
    });
    await waitFor(() => expect(input).toHaveFocus());

    expect(input).toHaveAttribute("aria-activedescendant", firstPrimary.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", secondPrimary.id);
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(input).toHaveAttribute("aria-activedescendant", secondPrimary.id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(input).toHaveAttribute("aria-activedescendant", firstActions.id);
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(input).toHaveAttribute("aria-activedescendant", firstPrimary.id);

    await user.tab();
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: /Actions for Reading notes/ })).not.toHaveFocus();
  });

  it("activates only the primary cell with Enter and Shift+Enter", () => {
    const selected = entry();
    const value = controller({
      projection: projection([group("Results", "Results", [selected])]),
    });
    render(<DesktopNexus controller={value} />);
    const input = screen.getByRole("combobox", { name: "Find anything…" });

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(value.activatePrimary).toHaveBeenNthCalledWith(1, {
      entry: selected,
      disposition: "Follow",
      modality: "Keyboard",
    });
    expect(value.activatePrimary).toHaveBeenNthCalledWith(2, {
      entry: selected,
      disposition: "Fork",
      modality: "Keyboard",
    });
  });

  it("uses Follow and Fork for the exact pointer-selected primary row", () => {
    const selected = entry();
    const value = controller({
      projection: projection([group("Results", "Results", [selected])]),
    });
    render(<DesktopNexus controller={value} />);
    const primary = screen.getByRole("gridcell", {
      name: /^Reading notes\./,
    });

    fireEvent.click(primary);
    fireEvent.click(primary, { shiftKey: true });
    fireEvent.click(primary, { metaKey: true });

    expect(value.setActiveEntry).toHaveBeenCalledWith(selected.key);
    expect(value.activatePrimary).toHaveBeenNthCalledWith(1, {
      entry: selected,
      disposition: "Follow",
      modality: "Pointer",
    });
    expect(value.activatePrimary).toHaveBeenNthCalledWith(2, {
      entry: selected,
      disposition: "Fork",
      modality: "Pointer",
    });
    expect(value.activatePrimary).toHaveBeenCalledTimes(2);
  });

  it("requires pointer movement before reflow can change virtual selection", () => {
    const first = entry();
    const second = entry({
      key: { kind: "Pane", paneId: "two" },
      label: "Project notes",
    });
    const value = controller({
      projection: projection(
        [group("Results", "Results", [first, second])],
        first.key,
      ),
    });
    render(<DesktopNexus controller={value} />);
    const secondPrimary = screen.getByRole("gridcell", {
      name: /^Project notes\./,
    });
    const secondActions = screen.getByRole("button", {
      name: "Actions for Project notes",
    });

    fireEvent.pointerEnter(secondPrimary);
    fireEvent.pointerEnter(secondActions);
    expect(value.setActiveEntry).not.toHaveBeenCalled();

    fireEvent.pointerMove(secondPrimary);
    expect(value.setActiveEntry).toHaveBeenLastCalledWith(second.key);

    fireEvent.pointerMove(secondActions);
    expect(value.setActiveEntry).toHaveBeenLastCalledWith(second.key);
  });

  it("leaves composition keys with the IME and clears before dismissing Root", () => {
    const value = controller({ query: "かな" });
    const view = render(<DesktopNexus controller={value} />);
    const input = screen.getByRole("combobox", { name: "Find anything…" });

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    fireEvent.compositionEnd(input);

    expect(value.activatePrimary).not.toHaveBeenCalled();
    expect(value.setActiveEntry).not.toHaveBeenCalled();
    expect(value.setQuery).not.toHaveBeenCalled();
    expect(value.escape).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(value.setQuery).toHaveBeenCalledWith("");
    expect(value.escape).not.toHaveBeenCalled();

    const blank = controller({ query: "" });
    view.rerender(<DesktopNexus controller={blank} />);
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Find anything…" }),
      { key: "Escape" },
    );
    expect(blank.escape).toHaveBeenCalledOnce();
  });

  it("opens the active Actions cell with the real menu and returns virtual focus there", async () => {
    const user = userEvent.setup();
    const selected = entry();
    const value = controller({
      projection: projection([group("Results", "Results", [selected])]),
    });
    render(<StatefulDesktopNexus value={value} />);
    const input = screen.getByRole("combobox", { name: "Find anything…" });
    const actionsCell = screen.getByRole("gridcell", {
      name: /Actions for Reading notes/,
    });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.keyDown(input, { key: "Enter" });
    const share = await screen.findByRole("menuitem", { name: "Share" });
    await waitFor(() => expect(share).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute("aria-activedescendant", actionsCell.id);

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Share" })).toHaveFocus(),
    );
    await user.keyboard("{Enter}");
    expect(value.activateAction).toHaveBeenCalledWith({
      entry: selected,
      action: selected.secondaryActions[0],
      modality: "Keyboard",
    });
    expect(value.activatePrimary).not.toHaveBeenCalled();
  });

  it("selects a pointer row before opening and invokes that row's snapshotted action", async () => {
    const user = userEvent.setup();
    const first = entry();
    const secondAction = action("archive", "Archive");
    const second = entry({
      key: { kind: "Pane", paneId: "two" },
      label: "Project notes",
      secondaryActions: [secondAction],
    });
    const value = controller({
      projection: projection(
        [group("Results", "Results", [first, second])],
        first.key,
      ),
    });
    render(<StatefulDesktopNexus value={value} />);

    await user.click(
      screen.getByRole("button", { name: "Actions for Project notes" }),
    );
    expect(value.setActiveEntry).toHaveBeenCalledWith(second.key);
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));

    expect(value.activateAction).toHaveBeenCalledWith({
      entry: second,
      action: secondAction,
      modality: "Pointer",
    });
    expect(value.activatePrimary).not.toHaveBeenCalled();
  });

  it("uses the configured Nexus.Open request and preserves its exact action snapshot", async () => {
    const user = userEvent.setup();
    const key = { kind: "Pane", paneId: "one" } as const;
    const current = entry({
      key,
      secondaryActions: [action("delete", "Delete")],
    });
    const snapshottedAction = action("share", "Share snapshot");
    const snapshotted = entry({ key, secondaryActions: [snapshottedAction] });
    const value = controller({
      nexusOpenShortcutLabel: "Ctrl+J",
      projection: projection([group("Results", "Results", [current])], key),
      actionsRequest: { requestId: 42, entry: snapshotted },
    });
    render(<DesktopNexus controller={value} />);

    const menuItem = await screen.findByRole("menuitem", {
      name: "Share snapshot",
    });
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    expect(
      within(
        screen.getByRole("button", { name: "Actions for Reading notes" }),
      ).getByText("Ctrl+J"),
    ).toBeVisible();

    await waitFor(() => expect(menuItem).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(value.activateAction).toHaveBeenCalledWith({
      entry: snapshotted,
      action: snapshottedAction,
      modality: "Keyboard",
    });
  });

  it("exposes unavailable reasons and never invokes a disabled menu action", async () => {
    const user = userEvent.setup();
    const reason = "Open Today to finish the current embedded draft";
    const unavailable = action("append", "Add to Today", {
      kind: "Unavailable",
      reason,
    });
    const selected = entry({
      primaryAction: unavailable,
      secondaryActions: [unavailable],
    });
    const value = controller({
      announcement: reason,
      projection: projection([group("QueryActions", "Do with query", [selected])]),
    });
    render(<DesktopNexus controller={value} />);

    const primary = screen.getByRole("gridcell", {
      name: /^Reading notes\./,
    });
    expect(primary).toHaveAttribute("aria-disabled", "true");
    expect(primary).toHaveAccessibleDescription(reason);

    await user.click(
      screen.getByRole("button", { name: "Actions for Reading notes" }),
    );
    const menuItem = await screen.findByRole("menuitem", {
      name: "Add to Today",
    });
    expect(menuItem).toHaveAttribute("aria-disabled", "true");
    expect(menuItem).toHaveAccessibleDescription(reason);
    await user.click(menuItem);

    expect(value.activateAction).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(`${reason}.*0 results.*1 query action`))).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("announces provider state and keeps each source retry local", async () => {
    const user = userEvent.setup();
    const value = controller({
      busy: true,
      failures: new Set(["Openables", "Owned"]),
    });
    render(<DesktopNexus controller={value} />);

    expect(screen.getByRole("grid")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Searching…")).toHaveAttribute("aria-live", "polite");
    const retries = screen.getAllByRole("button", { name: "Retry" });
    await user.click(retries[0]!);
    await user.click(retries[1]!);

    expect(value.retry).toHaveBeenNthCalledWith(1, "Openables");
    expect(value.retry).toHaveBeenNthCalledWith(2, "Owned");
  });

  it("keeps workflows in the dialog and delegates guarded backdrop dismissal", async () => {
    const value = controller({
      workflow: (
        <button data-nexus-workflow-initial-focus>Continue import</button>
      ),
    });
    render(<DesktopNexus controller={value} />);

    const workflow = screen.getByRole("button", { name: "Continue import" });
    expect(screen.getByRole("dialog", { name: "Nexus" })).toContainElement(
      workflow,
    );
    await waitFor(() => expect(workflow).toHaveFocus());

    fireEvent.click(screen.getByRole("presentation"));
    expect(value.escape).toHaveBeenCalledOnce();
  });
});
