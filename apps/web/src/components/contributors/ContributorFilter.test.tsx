import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import ContributorFilter from "./ContributorFilter";

describe("ContributorFilter", () => {
  it("loads selected author labels and filters selected handles from suggestions", async () => {
    const onChange = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/contributors/ursula-le-guin") {
          return jsonResponse({
            data: {
              handle: "ursula-le-guin",
              display_name: "Ursula K. Le Guin",
            },
          });
        }
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

    render(<ContributorFilter selectedHandles={["ursula-le-guin"]} onChange={onChange} />);

    expect(await screen.findByRole("link", { name: "Ursula K. Le Guin" })).toHaveAttribute(
      "href",
      "/authors/ursula-le-guin",
    );

    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Filter by author" }), "le");

    expect(await screen.findByRole("button", { name: "Octavia E. Butler" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Ursula K. Le Guin" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Octavia E. Butler" }));
    expect(onChange).toHaveBeenCalledWith(["ursula-le-guin", "octavia-butler"]);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Octavia E. Butler" })).not.toBeInTheDocument();
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
