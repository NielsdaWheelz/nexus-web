import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PeopleSearchCombobox from "./PeopleSearchCombobox";

const people = [
  {
    userHandle:
      "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
    displayName: { kind: "Present" as const, value: "Ada Lovelace" },
    email: { kind: "Present" as const, value: "ada@example.test" },
  },
  {
    userHandle:
      "nus1.CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD",
    displayName: { kind: "Present" as const, value: "Grace Hopper" },
    email: { kind: "Present" as const, value: "grace@example.test" },
  },
];

describe("PeopleSearchCombobox", () => {
  it("supports established listbox arrows, Home/End, Enter, and Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PeopleSearchCombobox
        label="Search people"
        placeholder="Name or email…"
        description="Find an existing account."
        status="2 results"
        query="a"
        results={people}
        onQueryChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    const input = screen.getByRole("combobox", { name: "Search people" });
    expect(
      within(screen.getAllByRole("option")[0]).queryByRole("button"),
    ).toBeNull();
    await user.click(input);
    await user.keyboard("{End}");
    const activeId = input.getAttribute("aria-activedescendant");
    expect(activeId).toBe(screen.getAllByRole("option")[1]?.id);
    expect(input).toHaveAccessibleDescription(
      "Find an existing account. 2 results",
    );
    await user.keyboard("{Home}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(people[1]);

    await user.click(input);
    await user.keyboard("{ArrowDown}{Escape}");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("uses collision-free identities for multiple mounted instances", () => {
    render(
      <>
        <PeopleSearchCombobox
          label="First people search"
          placeholder="Search…"
          query="ada"
          results={people}
          onQueryChange={vi.fn()}
          onSelect={vi.fn()}
        />
        <PeopleSearchCombobox
          label="Second people search"
          placeholder="Search…"
          query="ada"
          results={people}
          onQueryChange={vi.fn()}
          onSelect={vi.fn()}
        />
      </>,
    );

    const first = screen.getByRole("combobox", { name: "First people search" });
    const second = screen.getByRole("combobox", { name: "Second people search" });
    expect(first).not.toHaveAttribute(
      "aria-controls",
      second.getAttribute("aria-controls"),
    );
  });
});
