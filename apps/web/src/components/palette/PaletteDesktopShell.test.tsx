import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import PaletteDesktopShell from "@/components/palette/PaletteDesktopShell";
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
      sectionId: "navigate",
      label: "Go to",
      commands: [
        command({ id: "nav-library", title: "Library", shortcutLabel: "Ctrl L" }),
        command({ id: "nav-oracle", title: "Oracle" }),
      ],
    },
  ],
};

function renderShell(
  props: Partial<React.ComponentProps<typeof PaletteDesktopShell>> = {},
) {
  return render(
    <PaletteDesktopShell
      query=""
      view={restingView}
      searchLoading={false}
      initialActiveCommandId={null}
      onQueryChange={vi.fn()}
      onSelect={vi.fn()}
      onTrailingAction={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe("PaletteDesktopShell", () => {
  it("renders the centered card as a native dialog", async () => {
    renderShell();

    const dialog = await screen.findByRole("dialog", { name: /command palette/i });
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("open");
  });

  it("moves aria-activedescendant when ArrowDown is pressed on the input", async () => {
    const user = userEvent.setup();
    renderShell();

    const input = screen.getByRole("combobox", { name: /search commands/i });
    await user.click(input);
    await user.keyboard("{ArrowDown}");

    expect(input).toHaveAttribute("aria-activedescendant", "palette-option-nav-oracle");
  });

  it("selects the active command when Enter is pressed", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderShell({ initialActiveCommandId: "nav-oracle", onSelect });

    await user.click(screen.getByRole("combobox", { name: /search commands/i }));
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "nav-oracle" }));
  });

  it("closes when Escape is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderShell({ onClose });

    await user.click(screen.getByRole("combobox", { name: /search commands/i }));
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the close button is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderShell({ onClose });

    await user.click(screen.getByRole("button", { name: "Close command palette" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders shortcut hints on rows that have a shortcut label", async () => {
    renderShell();

    const row = await screen.findByRole("option", { name: /Library/i });
    expect(row).toHaveTextContent("Ctrl L");
  });

  it("invokes onTrailingAction when the inline close button is clicked", async () => {
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
    renderShell({ view, onTrailingAction });

    await user.click(screen.getByRole("button", { name: "Close My Doc" }));

    expect(onTrailingAction).toHaveBeenCalledWith(expect.objectContaining({ id: "pane-open-1" }));
  });
});
