import { render, screen, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import PaletteBody from "@/components/palette/PaletteBody";
import type { PaletteCommand, PaletteView } from "@/components/palette/types";

const TestIcon = (() => <svg aria-hidden="true" />) as PaletteCommand["icon"];

function command(
  overrides: Partial<PaletteCommand> & Pick<PaletteCommand, "id" | "title">,
): PaletteCommand {
  return {
    keywords: [],
    sectionId: "navigate",
    icon: TestIcon,
    target: { kind: "href", href: "/libraries", externalShell: false },
    source: "static",
    rank: {},
    ...overrides,
  };
}

const restingView: PaletteView = {
  state: "resting",
  groups: [
    {
      sectionId: "open-tabs",
      label: "Open tabs",
      commands: [command({ id: "tab-oracle", title: "Oracle" })],
    },
    {
      sectionId: "navigate",
      label: "Go to",
      commands: [
        command({ id: "nav-library", title: "Library" }),
        command({ id: "nav-settings", title: "Settings" }),
      ],
    },
  ],
};

const queryingView: PaletteView = {
  state: "querying",
  results: [
    command({ id: "result-library", title: "Library", sectionId: "navigate" }),
    command({ id: "result-oracle", title: "Oracle", sectionId: "open-tabs" }),
  ],
};

function Harness({
  view,
  scopeLabel = null,
  activeCommandId = null,
  onSelect = vi.fn(),
  onClearScope = vi.fn(),
}: {
  view: PaletteView;
  scopeLabel?: string | null;
  activeCommandId?: string | null;
  onSelect?: (command: PaletteCommand) => void;
  onClearScope?: () => void;
}) {
  const [query, setQuery] = useState(view.state === "querying" ? "li" : "");
  const [active, setActive] = useState<string | null>(activeCommandId);

  return (
    <PaletteBody
      view={view}
      query={query}
      searchLoading={false}
      scopeLabel={scopeLabel}
      activeCommandId={active}
      showShortcuts
      autoFocusInput={false}
      onQueryChange={setQuery}
      onClearScope={onClearScope}
      onSelect={onSelect}
      onActiveCommandChange={setActive}
    />
  );
}

describe("PaletteBody", () => {
  it("renders the resting view as sections of options", () => {
    render(<Harness view={restingView} />);

    const listbox = screen.getByRole("listbox");
    const openTabs = within(listbox).getByRole("group", { name: "Open tabs" });
    expect(within(openTabs).getByRole("option", { name: /Oracle/i })).toBeInTheDocument();

    const goTo = within(listbox).getByRole("group", { name: "Go to" });
    expect(within(goTo).getAllByRole("option")).toHaveLength(2);
  });

  it("renders the querying view as one flat list with no section headings", () => {
    render(<Harness view={queryingView} />);

    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("wires combobox and listbox accessibility roles", () => {
    render(<Harness view={restingView} activeCommandId="nav-library" />);

    const input = screen.getByRole("combobox", { name: /search commands/i });
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-controls", "palette-listbox");
    expect(input).toHaveAttribute("aria-activedescendant", "palette-option-nav-library");

    const listbox = screen.getByRole("listbox");
    expect(listbox).toHaveAttribute("id", "palette-listbox");
  });

  it("selects the active command when Enter is pressed", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness view={restingView} activeCommandId="nav-settings" onSelect={onSelect} />);

    await user.click(screen.getByRole("combobox", { name: /search commands/i }));
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "nav-settings" }));
  });

  it("selects the first command of the view when Enter is pressed with no active command", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness view={restingView} onSelect={onSelect} />);

    await user.click(screen.getByRole("combobox", { name: /search commands/i }));
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "tab-oracle" }));
  });

  it("shows the scope row and clears the scope when its button is pressed", async () => {
    const user = userEvent.setup();
    const onClearScope = vi.fn();
    render(<Harness view={restingView} scopeLabel="In this article" onClearScope={onClearScope} />);

    const scopeRow = screen.getByTestId("palette-scope-chip");
    expect(within(scopeRow).getByText("In this article")).toBeInTheDocument();

    await user.click(within(scopeRow).getByRole("button", { name: "Clear scope" }));
    expect(onClearScope).toHaveBeenCalledTimes(1);
  });

  it("omits the scope row when there is no scope label", () => {
    render(<Harness view={restingView} />);

    expect(screen.queryByTestId("palette-scope-chip")).not.toBeInTheDocument();
  });

  it("shows a no-matches status when every querying result is pinned", () => {
    const emptyResults: PaletteView = {
      state: "querying",
      results: [
        command({ id: "see-all-search", title: "See all results", source: "search", pin: "last" }),
      ],
    };
    render(<Harness view={emptyResults} />);

    expect(screen.getByRole("status")).toHaveTextContent("No matches");
  });
});
