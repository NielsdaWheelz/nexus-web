import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import Disclosure from "./Disclosure";

describe("Disclosure", () => {
  it("toggles an aria-linked region from the summary button", async () => {
    const user = userEvent.setup();
    render(
      <Disclosure summary="2 linked chats">
        <button type="button">Linked chat</button>
      </Disclosure>,
    );

    const summary = screen.getByRole("button", { name: "2 linked chats" });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(summary).toHaveAttribute("aria-controls");
    expect(screen.queryByRole("region")).toBeNull();

    await user.click(summary);

    const region = screen.getByRole("region", { name: "2 linked chats" });
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(region.id).toBe(summary.getAttribute("aria-controls"));
    expect(screen.getByRole("button", { name: "Linked chat" })).toBeVisible();

    await user.keyboard("{Enter}");
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("can start open", () => {
    render(
      <Disclosure summary="Details" defaultOpen>
        <span>Visible detail</span>
      </Disclosure>,
    );

    expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Visible detail")).toBeVisible();
  });
});
