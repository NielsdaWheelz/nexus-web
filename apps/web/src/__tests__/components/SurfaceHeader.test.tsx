import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import type { ComponentProps } from "react";
import SurfaceHeader from "@/components/ui/SurfaceHeader";

function navigation(
  overrides: Partial<ComponentProps<typeof SurfaceHeader>["navigation"]> = {},
) {
  return {
    canGoBack: false,
    canGoForward: false,
    onBack: vi.fn(),
    onForward: vi.fn(),
    ...overrides,
  };
}

const sectionHeader = {
  kind: "section",
  standingHead: "Libraries",
  folio: { kind: "none" },
  pending: false,
} as const;

describe("SurfaceHeader", () => {
  it("renders section identity and the options menu", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();

    render(
      <SurfaceHeader
        header={{
          ...sectionHeader,
          folio: { kind: "count", value: 37, unit: "source" },
        }}
        identityId="pane-identity"
        navigation={navigation()}
        options={[
          {
            kind: "command",
            id: "delete",
            label: "Delete",
            onSelect: onDelete,
            tone: "danger",
          },
        ]}
      />,
    );

    expect(screen.getByText("Libraries")).toBeInTheDocument();
    expect(screen.getByText("37 sources")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByRole("banner")).toHaveAttribute(
      "data-header-kind",
      "section",
    );

    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("exposes an accessible loading label while a section folio resolves", () => {
    render(
      <SurfaceHeader
        header={{ ...sectionHeader, pending: true }}
        identityId="pane-identity"
        navigation={navigation()}
      />,
    );

    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("loops tab focus inside the options menu", async () => {
    const user = userEvent.setup();

    render(
      <SurfaceHeader
        header={sectionHeader}
        identityId="pane-identity"
        navigation={navigation()}
        options={[
          { kind: "command", id: "open", label: "Open source", onSelect: vi.fn() },
          {
            kind: "command",
            id: "delete",
            label: "Delete",
            onSelect: vi.fn(),
            tone: "danger",
          },
        ]}
      />,
    );

    const optionsToggle = screen.getByRole("button", { name: "Options" });
    await user.click(optionsToggle);

    const openSourceOption = screen.getByRole("menuitem", { name: "Open source" });
    const deleteOption = screen.getByRole("menuitem", { name: "Delete" });
    await waitFor(() => expect(openSourceOption).toHaveFocus());

    await user.tab();
    expect(deleteOption).toHaveFocus();
    await user.tab();
    expect(openSourceOption).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(optionsToggle).toHaveFocus());
  });

  it("keeps disabled link options non-interactive", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <SurfaceHeader
        header={sectionHeader}
        identityId="pane-identity"
        navigation={navigation()}
        options={[
          {
            kind: "link",
            id: "open-source",
            label: "Open source",
            href: "https://example.com",
            disabled: true,
            onSelect,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Options" }));
    const item = screen.getByRole("menuitem", { name: "Open source" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Options" })).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders pane Back and Forward controls with disabled states", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onForward = vi.fn();

    render(
      <SurfaceHeader
        header={sectionHeader}
        identityId="pane-identity"
        navigation={navigation({
          canGoBack: true,
          canGoForward: false,
          onBack,
          onForward,
        })}
      />,
    );

    const back = screen.getByRole("button", { name: "Go back in this pane" });
    const forward = screen.getByRole("button", { name: "Go forward in this pane" });
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();

    await user.click(back);
    fireEvent.click(forward);
    expect(onBack).toHaveBeenCalledWith("Pointer");
    expect(onForward).not.toHaveBeenCalled();
  });

  it("renders resource identity and typed header actions", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <SurfaceHeader
        header={{
          kind: "resource",
          resource: {
            status: "ready",
            title: "The Dispossessed",
            creditGroups: [
              { kind: "authors", credits: [{ label: "Ursula K. Le Guin" }] },
            ],
          },
        }}
        identityId="resource-identity"
        navigation={navigation()}
        actions={[
          {
            kind: "command",
            id: "resource-inspector-companion",
            label: "Companion",
            icon: <span aria-hidden="true">m</span>,
            onSelect: onToggle,
            state: {
              kind: "disclosure",
              expanded: false,
              menuLabels: {
                collapsed: "Show Companion",
                expanded: "Hide Companion",
              },
            },
          },
        ]}
      />,
    );

    expect(screen.getByRole("heading", { name: "The Dispossessed" })).toHaveAttribute(
      "id",
      "resource-identity",
    );
    expect(screen.getByRole("banner")).toHaveAttribute(
      "data-header-kind",
      "resource",
    );
    await user.click(screen.getByRole("button", { name: "Companion" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
