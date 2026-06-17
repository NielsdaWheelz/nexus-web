import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";
import ConversationContextRefsSurface from "./ConversationContextRefsSurface";

function contextRef(overrides: Partial<ContextRefOut> = {}): ContextRefOut {
  return {
    id: "ref-1",
    conversation_id: "conv-1",
    resource_ref: "media:m1",
    activation: {
      resourceRef: "media:m1",
      kind: "route",
      href: "/media/m1",
      unresolvedReason: null,
    },
    label: "Annual report",
    summary: "Page 4",
    missing: false,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("ConversationContextRefsSurface", () => {
  it("renders a context ref label", () => {
    render(
      <ConversationContextRefsSurface
        contextRefs={[contextRef()]}
        removeContextRef={async () => {}}
      />,
    );
    expect(screen.getByText("Annual report")).toBeVisible();
  });

  it("marks a missing context ref unavailable and disables Open", async () => {
    const user = userEvent.setup();
    render(
      <ConversationContextRefsSurface
        contextRefs={[contextRef({ missing: true })]}
        removeContextRef={async () => {}}
        onOpenResource={() => {}}
      />,
    );

    expect(screen.getByText("Annual report")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeDisabled();
  });

  it("removes a context ref from the actions menu", async () => {
    const user = userEvent.setup();
    const removeContextRef = vi.fn(async () => {});
    render(
      <ConversationContextRefsSurface
        contextRefs={[contextRef()]}
        removeContextRef={removeContextRef}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(removeContextRef).toHaveBeenCalledWith("ref-1");
  });

  it("opens a context ref from the body and actions menu", async () => {
    const user = userEvent.setup();
    const onOpenResource = vi.fn();
    render(
      <ConversationContextRefsSurface
        contextRefs={[contextRef()]}
        removeContextRef={async () => {}}
        onOpenResource={onOpenResource}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Annual report" }));
    expect(onOpenResource).toHaveBeenCalledWith(expect.objectContaining({ resource_ref: "media:m1" }));

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onOpenResource).toHaveBeenCalledTimes(2);
  });

  it("shows the empty state with no context refs", () => {
    render(
      <ConversationContextRefsSurface
        contextRefs={[]}
        removeContextRef={async () => {}}
      />,
    );
    expect(screen.getByText("No context yet.")).toBeVisible();
  });
});
