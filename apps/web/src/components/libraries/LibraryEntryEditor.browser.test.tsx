import { render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import LibraryEntryEditor from "@/components/libraries/LibraryEntryEditor";
import type { LibraryPlacementOption } from "@/lib/libraries/libraryPlacement";

const RESEARCH_ID = "11111111-1111-4111-8111-111111111111";
const SHARED_ID = "22222222-2222-4222-8222-222222222222";
const SYSTEM_ID = "33333333-3333-4333-8333-333333333333";
const SUBSCRIPTION_ID = "44444444-4444-4444-8444-444444444444";
const SOURCE_ID = "55555555-5555-4555-8555-555555555555";
const ADMIN_ID = "66666666-6666-4666-8666-666666666666";

function library(id: string, name: string, color: string | null = null) {
  return { kind: "Library" as const, library: { id, name, color } };
}

const PLACEMENTS: readonly LibraryPlacementOption[] = [
  {
    destination: { kind: "SavedInNexus" },
    relation: { kind: "Absent" },
    availability: { kind: "Available" },
  },
  {
    destination: library(RESEARCH_ID, "Research", "#334455"),
    relation: { kind: "Direct" },
    availability: { kind: "Available" },
  },
  {
    destination: library(SHARED_ID, "Shared reading"),
    relation: {
      kind: "Inherited",
      provenance: [
        { id: SOURCE_ID, name: "Following Ada", color: "#778899" },
      ],
    },
    availability: { kind: "Blocked", reason: "Inherited" },
  },
  {
    destination: library(SYSTEM_ID, "System inbox"),
    relation: { kind: "Absent" },
    availability: { kind: "Blocked", reason: "SystemManaged" },
  },
  {
    destination: library(SUBSCRIPTION_ID, "Podcast queue"),
    relation: { kind: "Absent" },
    availability: { kind: "Blocked", reason: "RequiresSubscription" },
  },
  {
    destination: library(ADMIN_ID, "Team research"),
    relation: { kind: "Direct" },
    availability: { kind: "Blocked", reason: "RequiresAdmin" },
  },
];

function renderEditor(
  overrides: Partial<ComponentProps<typeof LibraryEntryEditor>> = {},
) {
  const onToggle = vi.fn();
  const onCreateLibrary = vi.fn();
  render(
    <LibraryEntryEditor
      placements={PLACEMENTS}
      loading={false}
      busy={false}
      creating={false}
      pendingDestinationKey={null}
      error={null}
      onToggle={onToggle}
      onCreateLibrary={onCreateLibrary}
      selectedGroupLabel="In these libraries"
      otherGroupLabel="Other libraries"
      searchLabel="Search or create a library"
      searchPlaceholder="Search or create"
      listLabel="Library options"
      emptyInventory="No libraries yet. Type a name to create one."
      {...overrides}
    />,
  );
  return { onToggle, onCreateLibrary };
}

describe("LibraryEntryEditor canonical placement behavior", () => {
  it("renders Saved in Nexus, direct and inherited relations, provenance, and blocked reasons", () => {
    renderEditor();

    expect(screen.getByRole("option", { name: "Research" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("option", { name: /Shared reading/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByText(
        "Inherited from Following Ada · This placement is inherited from another library.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("This system library is managed automatically."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Subscribe to this podcast before adding it to a library.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("Only a library admin can change this placement."),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: "Saved in Nexus" }),
    ).toHaveAttribute("aria-selected", "false");
  });

  it("toggles only available destinations and keeps selected rows visible while searching", async () => {
    const { onToggle } = renderEditor();

    await userEvent.click(screen.getByRole("option", { name: "Saved in Nexus" }));
    expect(onToggle).toHaveBeenCalledWith({ kind: "SavedInNexus" });

    expect(
      screen.getByRole("option", { name: /System inbox/ }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(onToggle).toHaveBeenCalledTimes(1);

    const search = screen.getByRole("combobox", {
      name: "Search or create a library",
    });
    await userEvent.fill(search, "nothing matches");
    expect(screen.getByRole("option", { name: "Research" })).toBeVisible();
    expect(screen.getByRole("option", { name: /Shared reading/ })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Saved in Nexus" }),
    ).not.toBeInTheDocument();
  });

  it("offers the existing Create Library workflow for a new searched name", async () => {
    const { onCreateLibrary } = renderEditor();
    const search = screen.getByRole("combobox", {
      name: "Search or create a library",
    });
    await userEvent.fill(search, "Frontier notes");

    const listbox = screen.getByRole("listbox", { name: "Library options" });
    await userEvent.click(
      within(listbox).getByRole("option", { name: "Create “Frontier notes”" }),
    );
    expect(onCreateLibrary).toHaveBeenCalledWith("Frontier notes");
  });

  it("never presents an empty dead-end to a Default-only or no-library user", async () => {
    renderEditor({ placements: [] });
    expect(
      screen.getByText("No libraries yet. Type a name to create one."),
    ).toBeVisible();

    await userEvent.fill(
      screen.getByRole("combobox", { name: "Search or create a library" }),
      "First library",
    );
    expect(
      screen.getByRole("option", { name: "Create “First library”" }),
    ).toBeVisible();
  });
});
