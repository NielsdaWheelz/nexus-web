import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PeopleSearchCombobox from "./PeopleSearchCombobox";

const people = [
  {
    userHandle:
      "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
    displayName: "Ada Lovelace",
    email: "ada@example.test",
  },
  {
    userHandle:
      "nus1.CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD",
    displayName: "Grace Hopper",
    email: "grace@example.test",
  },
];

describe("PeopleSearchCombobox", () => {
  it("supports established listbox arrows, Home/End, Enter, and Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PeopleSearchCombobox
        id="people"
        label="Search people"
        placeholder="Name or email…"
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
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      "people-option-1",
    );
    await user.keyboard("{Home}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(people[1]);

    await user.click(input);
    await user.keyboard("{ArrowDown}{Escape}");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });
});
