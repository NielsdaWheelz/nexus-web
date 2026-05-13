import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import Palette from "@/components/palette/Palette";
import type { PaletteCommand, PaletteSection } from "@/components/palette/types";

const TestIcon = (() => <svg aria-hidden="true" />) as PaletteCommand["icon"];

const sections: PaletteSection[] = [
  { id: "top-result", label: "Top result", order: 0 },
  { id: "navigate", label: "Navigate", order: 10 },
  { id: "settings", label: "Settings", order: 20 },
];

function command(overrides: Partial<PaletteCommand> & Pick<PaletteCommand, "id" | "title">) {
  return {
    subtitle: undefined,
    keywords: [],
    sectionId: "navigate",
    icon: TestIcon,
    target: { kind: "href", href: "/libraries", externalShell: false },
    source: "static",
    rank: {} as PaletteCommand["rank"],
    ...overrides,
  } as PaletteCommand;
}

const commands = [
  command({
    id: "nav-library",
    title: "Library",
    subtitle: "Browse saved media",
    keywords: ["saved", "media"],
    sectionId: "top-result",
    shortcutActionId: "open-library",
  }),
  command({
    id: "nav-oracle",
    title: "Oracle",
    subtitle: "Open the Oracle workspace",
    keywords: ["ask", "reading"],
  }),
  command({
    id: "settings-keybindings",
    title: "Keyboard shortcuts",
    subtitle: "Manage keybindings",
    sectionId: "settings",
    target: { kind: "href", href: "/settings/keybindings", externalShell: false },
  }),
];

function PaletteHarness({
  initialActiveCommandId = "nav-library",
  onSelect = vi.fn(),
}: {
  initialActiveCommandId?: string | null;
  onSelect?: (command: PaletteCommand) => void;
}) {
  const [query, setQuery] = useState("li");
  const [activeCommandId, setActiveCommandId] = useState<string | null>(initialActiveCommandId);

  return (
    <Palette
      open
      query={query}
      sections={sections}
      commands={commands}
      activeCommandId={activeCommandId}
      loadingSectionIds={[]}
      onOpenChange={vi.fn()}
      onQueryChange={setQuery}
      onActiveCommandChange={setActiveCommandId}
      onSelect={onSelect}
    />
  );
}

describe("Palette", () => {
  it("renders the modal as a native dialog with combobox and listbox semantics", async () => {
    render(<PaletteHarness />);

    const dialog = await screen.findByRole("dialog", { name: /command palette/i });
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog).toHaveAttribute("open");

    const input = screen.getByRole("combobox", { name: /search commands/i });
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-controls", "palette-listbox");

    const listbox = screen.getByRole("listbox");
    expect(listbox).toHaveAttribute("id", "palette-listbox");

    const activeOptionId = input.getAttribute("aria-activedescendant");
    expect(activeOptionId).toBe("palette-option-nav-library");

    const activeOption = screen.getByRole("option", { selected: true });
    expect(activeOption).toHaveAttribute("id", activeOptionId);
    expect(activeOption).toHaveAttribute("role", "option");
    expect(activeOption).toHaveAccessibleName(/Library.*Top result.*Browse saved media/i);

    const topResultGroup = within(listbox).getByRole("group", { name: "Top result" });
    expect(within(topResultGroup).getByRole("option", { name: /Library/i })).toBe(activeOption);
  });

  it("keeps focus on the combobox while arrow keys update aria-activedescendant", async () => {
    const onSelect = vi.fn();
    render(<PaletteHarness onSelect={onSelect} />);

    const input = await screen.findByRole("combobox", { name: /search commands/i });
    input.focus();

    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-activedescendant", "palette-option-nav-oracle");
    expect(screen.getByRole("option", { selected: true })).toHaveAttribute(
      "id",
      "palette-option-nav-oracle",
    );

    fireEvent.keyDown(input, { key: "End" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-activedescendant", "palette-option-settings-keybindings");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "settings-keybindings" }));
  });

  it("omits aria-activedescendant when the active command is not mounted", async () => {
    render(<PaletteHarness initialActiveCommandId="missing-command" />);

    const input = await screen.findByRole("combobox", { name: /search commands/i });

    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("does not render interactive descendants inside options", async () => {
    render(<PaletteHarness />);

    const options = await screen.findAllByRole("option");

    for (const option of options) {
      expect(
        within(option).queryByRole("button") ??
          within(option).queryByRole("link") ??
          within(option).queryByRole("textbox") ??
          within(option).queryByRole("combobox") ??
          within(option).queryByRole("menu") ??
          within(option).queryByRole("checkbox") ??
          within(option).queryByRole("switch")
      ).toBeNull();
    }
  });
});
