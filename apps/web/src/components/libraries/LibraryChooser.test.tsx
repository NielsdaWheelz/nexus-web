import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LibraryChooser, {
  type LibraryChooserGroup,
  type LibraryChooserProps,
} from "./LibraryChooser";

const enabled = (
  id: string,
  name: string,
  selected: boolean,
): LibraryChooserGroup["items"][number] => ({
  id,
  name,
  color: "#22c55e",
  selected,
  interaction: { kind: "Enabled" },
});

const READ_ONLY_REASON = "Only owners and editors can change this.";

function baseProps(
  overrides: Partial<LibraryChooserProps> = {},
): LibraryChooserProps {
  return {
    query: "",
    onQueryChange: () => {},
    searchPlaceholder: "Search or create",
    searchLabel: "Search or create a library",
    listLabel: "Library options",
    selectedGroup: { label: "Selected", items: [] },
    otherGroup: { label: "Other libraries", items: [] },
    onToggle: () => {},
    busy: false,
    loading: false,
    status: "2 libraries",
    emptyState: null,
    error: null,
    create: null,
    loadMore: null,
    ...overrides,
  };
}

function Harness(overrides: Partial<LibraryChooserProps>) {
  const [query, setQuery] = useState(overrides.query ?? "");
  return (
    <LibraryChooser
      {...baseProps(overrides)}
      query={query}
      onQueryChange={setQuery}
    />
  );
}

function renderChooser(overrides: Partial<LibraryChooserProps> = {}) {
  return render(<Harness {...overrides} />);
}

describe("LibraryChooser", () => {
  it("renders a combobox and a multiselectable listbox with the given labels", () => {
    renderChooser({
      selectedGroup: { label: "Selected", items: [enabled("a", "Reading", true)] },
    });
    const combobox = screen.getByRole("combobox", {
      name: "Search or create a library",
    });
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox", { name: "Library options" });
    expect(listbox).toHaveAttribute("aria-multiselectable", "true");
    expect(combobox).toHaveAttribute("aria-controls", listbox.id);
  });

  it("renders a group header only for a non-empty group", () => {
    renderChooser({
      selectedGroup: { label: "Selected", items: [] },
      otherGroup: {
        label: "Other libraries",
        items: [enabled("b", "Field Notes", false)],
      },
    });
    expect(screen.queryByText("Selected")).toBeNull();
    expect(screen.getByText("Other libraries")).toBeInTheDocument();
  });

  it("marks a selected option with aria-selected and a check icon", () => {
    renderChooser({
      selectedGroup: { label: "Selected", items: [enabled("a", "Reading", true)] },
      otherGroup: {
        label: "Other libraries",
        items: [enabled("b", "Field Notes", false)],
      },
    });
    const selected = screen.getByRole("option", { name: "Reading" });
    expect(selected).toHaveAttribute("aria-selected", "true");
    // eslint-disable-next-line testing-library/no-node-access -- the selected check is aria-hidden; assert its presence directly
    expect(selected.querySelector("svg")).not.toBeNull();

    const unselected = screen.getByRole("option", { name: "Field Notes" });
    expect(unselected).toHaveAttribute("aria-selected", "false");
    // eslint-disable-next-line testing-library/no-node-access -- an unselected row renders no check svg
    expect(unselected.querySelector("svg")).toBeNull();
  });

  it("marks a read-only option as aria-disabled with its reason in the accessible name", () => {
    renderChooser({
      otherGroup: {
        label: "Other libraries",
        items: [
          {
            id: "ro",
            name: "Family Archive",
            color: null,
            selected: false,
            interaction: { kind: "ReadOnly", reason: READ_ONLY_REASON },
          },
        ],
      },
    });
    const option = screen.getByRole("option", {
      name: new RegExp(READ_ONLY_REASON.replace(/[.]/g, "\\.")),
    });
    expect(option).toHaveAttribute("aria-disabled", "true");
  });

  it("moves the active option with ArrowDown, Home, and End", () => {
    renderChooser({
      selectedGroup: { label: "Selected", items: [enabled("a", "Reading", true)] },
      otherGroup: {
        label: "Other libraries",
        items: [enabled("b", "Field Notes", false), enabled("c", "History", false)],
      },
    });
    const combobox = screen.getByRole("combobox");
    const first = screen.getByRole("option", { name: "Reading" });
    const second = screen.getByRole("option", { name: "Field Notes" });
    const third = screen.getByRole("option", { name: "History" });

    expect(combobox).toHaveAttribute("aria-activedescendant", first.id);
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    expect(combobox).toHaveAttribute("aria-activedescendant", second.id);
    fireEvent.keyDown(combobox, { key: "End" });
    expect(combobox).toHaveAttribute("aria-activedescendant", third.id);
    fireEvent.keyDown(combobox, { key: "Home" });
    expect(combobox).toHaveAttribute("aria-activedescendant", first.id);
  });

  it("toggles the active enabled option on Enter", () => {
    const onToggle = vi.fn();
    renderChooser({
      otherGroup: {
        label: "Other libraries",
        items: [enabled("b", "Field Notes", false)],
      },
      onToggle,
    });
    const combobox = screen.getByRole("combobox");
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(onToggle).toHaveBeenCalledWith("b");
  });

  it("does not toggle a read-only option on Enter", () => {
    const onToggle = vi.fn();
    renderChooser({
      otherGroup: {
        label: "Other libraries",
        items: [
          {
            id: "ro",
            name: "Family Archive",
            color: null,
            selected: false,
            interaction: { kind: "ReadOnly", reason: READ_ONLY_REASON },
          },
        ],
      },
      onToggle,
    });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("sets the listbox aria-busy and blocks toggles when busy", () => {
    const onToggle = vi.fn();
    renderChooser({
      otherGroup: {
        label: "Other libraries",
        items: [enabled("b", "Field Notes", false)],
      },
      onToggle,
      busy: true,
    });
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
    fireEvent.click(screen.getByRole("option", { name: "Field Notes" }));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("activates the create row and the load-more row", () => {
    const onCreate = vi.fn();
    const onLoadMore = vi.fn();
    renderChooser({
      otherGroup: {
        label: "Other libraries",
        items: [enabled("b", "Field Notes", false)],
      },
      create: { name: "History", pending: false, onCreate },
      loadMore: { pending: false, onLoadMore },
    });
    fireEvent.click(screen.getByText("Create “History”"));
    expect(onCreate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Load more libraries"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("shows an alert with Retry when the error is retryable", () => {
    const onRetry = vi.fn();
    renderChooser({
      error: { message: "Couldn’t load your libraries.", onRetry },
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t load your libraries.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows a terminal alert without Retry when onRetry is null", () => {
    renderChooser({
      error: { message: "This item is no longer available.", onRetry: null },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This item is no longer available.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows the empty-state row when both groups are empty", () => {
    renderChooser({ emptyState: "No libraries to place this in." });
    expect(
      screen.getByText("No libraries to place this in."),
    ).toBeInTheDocument();
  });
});
