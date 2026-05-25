import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import LibraryMultiSelectPicker, {
  type LibrarySummary,
} from "./LibraryMultiSelectPicker";

const baseLibraries: LibrarySummary[] = [
  { id: "lib-research", name: "Research", color: "#0ea5e9" },
  { id: "lib-books", name: "Books", color: "#22c55e" },
];

function DropdownHarness({
  initial = [],
  libraries = baseLibraries,
  onChange,
}: {
  initial?: string[];
  libraries?: LibrarySummary[];
  onChange?: (next: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(initial);
  return (
    <LibraryMultiSelectPicker
      mode="dropdown"
      selectedLibraryIds={selected}
      libraries={libraries}
      onChange={(next) => {
        setSelected(next);
        onChange?.(next);
      }}
    />
  );
}

function ModalHarness({
  initial = [],
  libraries = baseLibraries,
  onConfirm,
  onSkip,
}: {
  initial?: string[];
  libraries?: LibrarySummary[];
  onConfirm: (ids: string[]) => Promise<void> | void;
  onSkip: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(initial);
  return (
    <LibraryMultiSelectPicker
      mode="modal"
      open
      selectedLibraryIds={selected}
      libraries={libraries}
      onChange={setSelected}
      onConfirm={onConfirm}
      onSkip={onSkip}
      title="Add to libraries?"
    />
  );
}

describe("LibraryMultiSelectPicker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dropdown mode shows the My Library only label and updates it for one and many selections", () => {
    const { rerender } = render(
      <LibraryMultiSelectPicker
        mode="dropdown"
        selectedLibraryIds={[]}
        libraries={baseLibraries}
        onChange={() => {}}
      />
    );

    expect(
      screen.getByRole("button", { name: /My Library only/i })
    ).toBeInTheDocument();

    rerender(
      <LibraryMultiSelectPicker
        mode="dropdown"
        selectedLibraryIds={["lib-research"]}
        libraries={baseLibraries}
        onChange={() => {}}
      />
    );

    expect(
      screen.getByRole("button", { name: /\+ Research/ })
    ).toBeInTheDocument();

    rerender(
      <LibraryMultiSelectPicker
        mode="dropdown"
        selectedLibraryIds={["lib-research", "lib-books"]}
        libraries={baseLibraries}
        onChange={() => {}}
      />
    );

    expect(
      screen.getByRole("button", { name: /\+ 2 libraries/ })
    ).toBeInTheDocument();
  });

  it("dropdown mode toggles selection through onChange", () => {
    const handleChange = vi.fn();
    render(<DropdownHarness onChange={handleChange} />);

    fireEvent.click(screen.getByRole("button", { name: /My Library only/i }));

    const dialog = screen.getByRole("dialog", { name: "Select libraries" });
    fireEvent.click(within(dialog).getByRole("option", { name: /Research/ }));

    expect(handleChange).toHaveBeenLastCalledWith(["lib-research"]);

    fireEvent.click(within(dialog).getByRole("option", { name: /Books/ }));
    expect(handleChange).toHaveBeenLastCalledWith(["lib-research", "lib-books"]);

    fireEvent.click(within(dialog).getByRole("option", { name: /Research/ }));
    expect(handleChange).toHaveBeenLastCalledWith(["lib-books"]);
  });

  it("modal mode confirms with the current selection", async () => {
    const handleConfirm = vi.fn(async () => {});
    const handleSkip = vi.fn();

    render(
      <ModalHarness onConfirm={handleConfirm} onSkip={handleSkip} />
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Add to libraries?",
    });
    fireEvent.click(within(dialog).getByRole("option", { name: /Research/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    expect(handleConfirm).toHaveBeenCalledTimes(1);
    expect(handleConfirm).toHaveBeenCalledWith(["lib-research"]);
    expect(handleSkip).not.toHaveBeenCalled();
  });

  it("modal mode skip calls onSkip without onConfirm", async () => {
    const handleConfirm = vi.fn(async () => {});
    const handleSkip = vi.fn();

    render(
      <ModalHarness onConfirm={handleConfirm} onSkip={handleSkip} />
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Add to libraries?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Skip" }));

    expect(handleSkip).toHaveBeenCalledTimes(1);
    expect(handleConfirm).not.toHaveBeenCalled();
  });

  it("renders the empty state with a disabled chip in dropdown mode", () => {
    render(
      <LibraryMultiSelectPicker
        mode="dropdown"
        selectedLibraryIds={[]}
        libraries={[]}
        onChange={() => {}}
      />
    );

    const trigger = screen.getByRole("button", { name: /My Library only/i });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute(
      "title",
      "Create a library to file shared docs into multiple places."
    );
  });

  it("renders the empty state in modal mode with only Skip enabled", async () => {
    const handleConfirm = vi.fn(async () => {});
    const handleSkip = vi.fn();

    render(
      <ModalHarness
        libraries={[]}
        onConfirm={handleConfirm}
        onSkip={handleSkip}
      />
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Add to libraries?",
    });

    expect(
      within(dialog).getByText(
        "Create a library to file shared docs into multiple places."
      )
    ).toBeInTheDocument();

    const confirmButton = within(dialog).getByRole("button", {
      name: "Confirm",
    });
    expect(confirmButton).toBeDisabled();

    const skipButton = within(dialog).getByRole("button", { name: "Skip" });
    expect(skipButton).not.toBeDisabled();
  });

  it("filters libraries through the search input when there are more than 6", () => {
    const manyLibraries: LibrarySummary[] = [
      { id: "lib-a", name: "Alpha" },
      { id: "lib-b", name: "Bravo" },
      { id: "lib-c", name: "Charlie" },
      { id: "lib-d", name: "Delta" },
      { id: "lib-e", name: "Echo" },
      { id: "lib-f", name: "Foxtrot" },
      { id: "lib-g", name: "Golf" },
      { id: "lib-h", name: "Hotel" },
    ];

    render(<DropdownHarness libraries={manyLibraries} />);

    fireEvent.click(screen.getByRole("button", { name: /My Library only/i }));

    const dialog = screen.getByRole("dialog", { name: "Select libraries" });
    const searchInput = within(dialog).getByRole("searchbox", {
      name: "Search libraries",
    });

    fireEvent.change(searchInput, { target: { value: "alp" } });

    expect(within(dialog).getByRole("option", { name: /Alpha/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: /Bravo/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: /Charlie/ })).not.toBeInTheDocument();
  });
});
