import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConversationReference } from "@/lib/conversations/types";
import ConversationReferencesSidecar from "./ConversationReferencesSidecar";

function reference(
  overrides: Partial<ConversationReference> = {},
): ConversationReference {
  return {
    id: "ref-1",
    conversation_id: "conv-1",
    resource_uri: "media:m1",
    label: "Annual report",
    summary: "Page 4",
    inline_body: null,
    fetch_hint: "",
    missing: false,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("ConversationReferencesSidecar", () => {
  it("renders a reference label", () => {
    render(
      <ConversationReferencesSidecar
        references={[reference()]}
        removeReference={async () => {}}
      />,
    );
    expect(screen.getByText("Annual report")).toBeVisible();
  });

  it("marks a missing reference unavailable and disables Open", async () => {
    const user = userEvent.setup();
    render(
      <ConversationReferencesSidecar
        references={[reference({ missing: true })]}
        removeReference={async () => {}}
        onOpenResource={() => {}}
      />,
    );

    expect(screen.getByText("Annual report (unavailable)")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeDisabled();
  });

  it("removes a reference from the actions menu", async () => {
    const user = userEvent.setup();
    const removeReference = vi.fn(async () => {});
    render(
      <ConversationReferencesSidecar
        references={[reference()]}
        removeReference={removeReference}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(removeReference).toHaveBeenCalledWith("ref-1");
  });

  it("shows the empty state with no references", () => {
    render(
      <ConversationReferencesSidecar
        references={[]}
        removeReference={async () => {}}
      />,
    );
    expect(screen.getByText("No references yet.")).toBeVisible();
  });
});
