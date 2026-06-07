import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import ContributorPicker from "./ContributorPicker";

describe("ContributorPicker", () => {
  it("excludes the current handle and calls onSelect with the picked contributor", async () => {
    const onSelect = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/contributors?q=le") {
          return jsonResponse({
            data: {
              contributors: [
                {
                  handle: "ursula-le-guin",
                  display_name: "Ursula K. Le Guin",
                },
                {
                  handle: "octavia-butler",
                  display_name: "Octavia E. Butler",
                },
              ],
            },
          });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    render(<ContributorPicker excludeHandle="ursula-le-guin" onSelect={onSelect} />);

    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search authors" }), "le");

    const target = await screen.findByRole("button", { name: "Octavia E. Butler" });
    expect(
      screen.queryByRole("button", { name: "Ursula K. Le Guin" }),
    ).not.toBeInTheDocument();

    await user.click(target);
    expect(onSelect).toHaveBeenCalledWith({
      handle: "octavia-butler",
      display_name: "Octavia E. Butler",
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
