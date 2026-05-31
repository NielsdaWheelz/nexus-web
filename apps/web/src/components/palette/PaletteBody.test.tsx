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
  activeCommandId = null,
  initialQuery,
  onSelect = vi.fn(),
  onTrailingAction = vi.fn(),
}: {
  view: PaletteView;
  activeCommandId?: string | null;
  initialQuery?: string;
  onSelect?: (command: PaletteCommand) => void;
  onTrailingAction?: (command: PaletteCommand) => void;
}) {
  const [query, setQuery] = useState(
    initialQuery ?? (view.state === "querying" ? "li" : ""),
  );
  const [active, setActive] = useState<string | null>(activeCommandId);

  return (
    <PaletteBody
      view={view}
      query={query}
      searchLoading={false}
      activeCommandId={active}
      showShortcuts
      autoFocusInput={false}
      onQueryChange={setQuery}
      onSelect={onSelect}
      onTrailingAction={onTrailingAction}
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

  it("renders an inline close button when a command has a trailingAction", () => {
    const view: PaletteView = {
      state: "resting",
      groups: [
        {
          sectionId: "open-tabs",
          label: "Open tabs",
          commands: [
            command({
              id: "pane-open-1",
              title: "My Doc",
              sectionId: "open-tabs",
              trailingAction: { actionId: "pane-close:1", ariaLabel: "Close My Doc" },
            }),
          ],
        },
      ],
    };
    render(<Harness view={view} />);

    const row = screen.getByRole("option", { name: /My Doc/ });
    const button = within(row).getByRole("button", { name: "Close My Doc" });
    expect(button).toHaveAttribute("tabindex", "-1");
  });

  it("calls onTrailingAction and not onSelect when the inline close button is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onTrailingAction = vi.fn();
    const view: PaletteView = {
      state: "resting",
      groups: [
        {
          sectionId: "open-tabs",
          label: "Open tabs",
          commands: [
            command({
              id: "pane-open-1",
              title: "My Doc",
              sectionId: "open-tabs",
              trailingAction: { actionId: "pane-close:1", ariaLabel: "Close My Doc" },
            }),
          ],
        },
      ],
    };
    render(<Harness view={view} onSelect={onSelect} onTrailingAction={onTrailingAction} />);

    await user.click(screen.getByRole("button", { name: "Close My Doc" }));

    expect(onTrailingAction).toHaveBeenCalledWith(expect.objectContaining({ id: "pane-open-1" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("invokes onTrailingAction when Delete is pressed with empty input and an active trailingAction row", async () => {
    const user = userEvent.setup();
    const onTrailingAction = vi.fn();
    const view: PaletteView = {
      state: "resting",
      groups: [
        {
          sectionId: "open-tabs",
          label: "Open tabs",
          commands: [
            command({
              id: "pane-open-1",
              title: "My Doc",
              sectionId: "open-tabs",
              trailingAction: { actionId: "pane-close:1", ariaLabel: "Close My Doc" },
            }),
          ],
        },
      ],
    };
    render(<Harness view={view} activeCommandId="pane-open-1" onTrailingAction={onTrailingAction} />);

    await user.click(screen.getByRole("combobox", { name: /search commands/i }));
    await user.keyboard("{Delete}");

    expect(onTrailingAction).toHaveBeenCalledWith(expect.objectContaining({ id: "pane-open-1" }));
  });

  it("does not invoke onTrailingAction on Delete when the input is non-empty", async () => {
    const user = userEvent.setup();
    const onTrailingAction = vi.fn();
    const view: PaletteView = {
      state: "resting",
      groups: [
        {
          sectionId: "open-tabs",
          label: "Open tabs",
          commands: [
            command({
              id: "pane-open-1",
              title: "My Doc",
              sectionId: "open-tabs",
              trailingAction: { actionId: "pane-close:1", ariaLabel: "Close My Doc" },
            }),
          ],
        },
      ],
    };
    render(
      <Harness
        view={view}
        activeCommandId="pane-open-1"
        initialQuery="x"
        onTrailingAction={onTrailingAction}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: /search commands/i }));
    await user.keyboard("{Delete}");

    expect(onTrailingAction).not.toHaveBeenCalled();
  });

  it("does not invoke onTrailingAction on Backspace", async () => {
    const user = userEvent.setup();
    const onTrailingAction = vi.fn();
    const view: PaletteView = {
      state: "resting",
      groups: [
        {
          sectionId: "open-tabs",
          label: "Open tabs",
          commands: [
            command({
              id: "pane-open-1",
              title: "My Doc",
              sectionId: "open-tabs",
              trailingAction: { actionId: "pane-close:1", ariaLabel: "Close My Doc" },
            }),
          ],
        },
      ],
    };
    render(<Harness view={view} activeCommandId="pane-open-1" onTrailingAction={onTrailingAction} />);

    await user.click(screen.getByRole("combobox", { name: /search commands/i }));
    await user.keyboard("{Backspace}");

    expect(onTrailingAction).not.toHaveBeenCalled();
  });

  it("suppresses the section tag on a querying row that has a trailingAction", () => {
    const view: PaletteView = {
      state: "querying",
      results: [
        command({
          id: "pane-open-1",
          title: "My Doc",
          sectionId: "open-tabs",
          trailingAction: { actionId: "pane-close:1", ariaLabel: "Close My Doc" },
        }),
      ],
    };
    render(<Harness view={view} />);

    const row = screen.getByRole("option", { name: /My Doc/ });
    expect(within(row).queryByText("Tab")).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Close My Doc" })).toBeInTheDocument();
  });
});
