import { useMemo, useState } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { RESOURCE_ACTION_LEDGER } from "../../../e2e/resourceActionProductOracle";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import ActionMenu from "./ActionMenu";

function ActionMenuHarness() {
  const [lastAction, setLastAction] = useState("None");
  const options = useMemo<readonly ActionDescriptor[]>(
    () => [
      {
        kind: "command",
        id: "ResourceAction.Open",
        label: "Open",
        icon: <svg data-testid="open-action-icon" aria-hidden="true" />,
        onSelect: () => setLastAction("Open"),
      },
      {
        kind: "command",
        id: "RelationshipAction.LecternMembership",
        label: "Add to Lectern",
        icon: <svg data-testid="lectern-action-icon" aria-hidden="true" />,
        disabled: true,
        disabledReason: "Lectern is full. Remove an item to add this one.",
        onSelect: () => setLastAction("Lectern"),
      },
      {
        kind: "command",
        id: "ResourceOperation.Media.Remove",
        label: "Remove from Nexus",
        icon: <svg data-testid="remove-action-icon" aria-hidden="true" />,
        tone: "danger",
        separatorBefore: true,
        onSelect: () => setLastAction("Remove"),
      },
    ],
    [],
  );

  return (
    <>
      <ActionMenu label="Actions for Water on the Moon" options={options} />
      <output aria-label="Last action">{lastAction}</output>
    </>
  );
}

function ExhaustiveActionMenuHarness() {
  const [lastAction, setLastAction] = useState("None");
  const options = useMemo<readonly ActionDescriptor[]>(
    () =>
      RESOURCE_ACTION_LEDGER.map((action, index) => ({
        kind: "command" as const,
        id: action.id,
        label: action.label,
        tone: action.tone,
        separatorBefore:
          index > 0 &&
          RESOURCE_ACTION_LEDGER[index - 1]?.group !== action.group,
        onSelect: () => setLastAction(action.id),
      })),
    [],
  );
  return (
    <>
      <ActionMenu label="Actions for Complete resource" options={options} />
      <output aria-label="Last exhaustive action">{lastAction}</output>
    </>
  );
}

describe("ActionMenu public resource-action contract", () => {
  afterEach(async () => {
    await page.viewport(1_024, 768);
  });

  it("keeps an unavailable trigger focusable and makes pointer, Enter, and Space inert", async () => {
    render(
      <ActionMenu
        label="Actions for Water on the Moon"
        options={[]}
        triggerDisabled
        triggerDisabledReason="Actions are still loading."
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Actions for Water on the Moon",
    });
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).toHaveAccessibleDescription("Actions are still loading.");
    await userEvent.tab();
    expect(trigger).toHaveFocus();

    fireEvent.pointerDown(trigger);
    fireEvent.pointerUp(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.keyboard(" ");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("renders the catalog icon and stable ID for every ordered menu item", async () => {
    render(<ActionMenuHarness />);
    const trigger = screen.getByRole("button", {
      name: "Actions for Water on the Moon",
    });
    await userEvent.click(trigger);

    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Open",
      "Add to Lectern",
      "Remove from Nexus",
    ]);
    expect(items.map((item) => item.getAttribute("data-action-id"))).toEqual([
      "ResourceAction.Open",
      "RelationshipAction.LecternMembership",
      "ResourceOperation.Media.Remove",
    ]);
    expect(
      items.map((item) => item.getAttribute("data-action-tone")),
    ).toEqual(["default", "default", "danger"]);
    expect(
      items.map((item) => item.getAttribute("data-action-availability")),
    ).toEqual(["Available", "Blocked", "Available"]);
    expect(within(items[0]!).getByTestId("open-action-icon")).toBeVisible();
    expect(within(items[1]!).getByTestId("lectern-action-icon")).toBeVisible();
    expect(within(items[2]!).getByTestId("remove-action-icon")).toBeVisible();
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
  });

  it("keeps a blocked action discoverable and inert, explains it, and restores trigger focus", async () => {
    render(<ActionMenuHarness />);
    const trigger = screen.getByRole("button", {
      name: "Actions for Water on the Moon",
    });
    await userEvent.click(trigger);

    const blocked = screen.getByRole("menuitem", { name: "Add to Lectern" });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveAccessibleDescription(
      "Lectern is full. Remove an item to add this one.",
    );
    await userEvent.keyboard("{ArrowDown}");
    expect(blocked).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(
      screen.getByRole("status", { name: "Last action" }),
    ).toHaveTextContent("None");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("dismisses an open menu whose actions disappear and restores trigger focus", async () => {
    const option: ActionDescriptor = {
      kind: "command",
      id: "ResourceAction.Open",
      label: "Open",
      onSelect: () => undefined,
    };
    const { rerender } = render(
      <ActionMenu
        label="Actions for disappearing resource"
        options={[option]}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Actions for disappearing resource",
    });
    await userEvent.click(trigger);
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Open" })).toHaveFocus(),
    );

    rerender(
      <ActionMenu
        label="Actions for disappearing resource"
        options={[]}
        triggerDisabled
        triggerDisabledReason="No actions are available."
      />,
    );

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).toHaveAccessibleDescription("No actions are available.");
  });

  it.each([
    { width: 320, height: 568, requiresScroll: true },
    { width: 390, height: 844, requiresScroll: false },
  ])(
    "keeps the complete 43-action menu reachable by pointer and keyboard at $width px",
    async ({ width, height, requiresScroll }) => {
      await page.viewport(width, height);
      render(<ExhaustiveActionMenuHarness />);
      const trigger = screen.getByRole("button", {
        name: "Actions for Complete resource",
      });

      // Pointer path: the full menu is viewport-clamped and scrollable, and its
      // last action remains reachable rather than clipping below the phone.
      await userEvent.click(trigger);
      const menu = screen.getByRole("menu");
      const items = within(menu).getAllByRole("menuitem");
      expect(items).toHaveLength(RESOURCE_ACTION_LEDGER.length);
      expect(items[0]).toHaveAccessibleName("Open");
      expect(items.at(-1)).toHaveAccessibleName("Delete page");
      await waitFor(() => {
        const bounds = menu.getBoundingClientRect();
        expect(bounds.top).toBeGreaterThanOrEqual(8);
        expect(bounds.bottom).toBeLessThanOrEqual(height - 8);
        expect(menu.scrollHeight > menu.clientHeight).toBe(requiresScroll);
        expect(getComputedStyle(menu).overflowY).toBe("auto");
      });
      const lastItem = items.at(-1)!;
      lastItem.scrollIntoView({ block: "nearest", inline: "nearest" });
      await waitFor(() => {
        const scrollportBounds = menu.getBoundingClientRect();
        const itemBounds = lastItem.getBoundingClientRect();
        expect(itemBounds.top).toBeGreaterThanOrEqual(scrollportBounds.top);
        expect(itemBounds.right).toBeLessThanOrEqual(scrollportBounds.right);
        expect(itemBounds.bottom).toBeLessThanOrEqual(scrollportBounds.bottom);
        expect(itemBounds.left).toBeGreaterThanOrEqual(scrollportBounds.left);
      });
      await userEvent.click(lastItem);
      expect(
        screen.getByRole("status", { name: "Last exhaustive action" }),
      ).toHaveTextContent("ResourceOperation.Page.Delete");
      await waitFor(() => expect(trigger).toHaveFocus());

      // Keyboard path: Enter opens the same menu, End reaches the final item,
      // and activation dismisses it and restores focus to the named trigger.
      await userEvent.keyboard("{Enter}");
      const keyboardMenu = screen.getByRole("menu");
      const keyboardItems = within(keyboardMenu).getAllByRole("menuitem");
      await waitFor(() => expect(keyboardItems[0]).toHaveFocus());
      await userEvent.keyboard("{End}");
      expect(keyboardItems.at(-1)).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    },
  );
});
