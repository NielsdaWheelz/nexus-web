import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ResourceHead from "./ResourceHead";

describe("ResourceHead", () => {
  it("renders a primary title and compact non-focusable credit summary", () => {
    render(
      <ResourceHead
        id="resource-heading"
        resource={{
          status: "ready",
          title: "The Left Hand of Darkness",
          creditGroups: [
            {
              kind: "authors",
              credits: [
                { label: "Ursula K. Le Guin", href: "/authors/ursula" },
                { label: "Brian Attebery", href: "/authors/brian" },
              ],
            },
            {
              kind: "role",
              label: "Translator",
              credits: [{ label: "Margaret Chodos-Irvine", href: "/authors/margaret" }],
            },
          ],
        }}
      />,
    );

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "The Left Hand of Darkness",
    });
    expect(heading).toHaveAttribute("id", "resource-heading");
    expect(heading).not.toHaveAttribute("aria-busy");
    expect(screen.getByText(/Ursula K\. Le Guin/)).toBeInTheDocument();
    expect(screen.getByText(/Translator:/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Authors:")).toHaveClass("sr-only");
  });

  it("keeps a named busy heading while pending", () => {
    render(
      <ResourceHead
        id="pending-heading"
        resource={{ status: "pending", accessibleLabel: "Loading media…" }}
      />,
    );

    const heading = screen.getByRole("heading", { level: 1, name: "Loading media…" });
    expect(heading).toHaveAttribute("aria-busy", "true");
    expect(heading).toHaveAttribute("id", "pending-heading");
  });

  it.each([
    { status: "unavailable" as const, title: "Media unavailable" },
    { status: "failed" as const, title: "Media failed to load" },
  ])("renders the $status title without a busy state", ({ status, title }) => {
    render(<ResourceHead id={`${status}-heading`} resource={{ status, title }} />);
    expect(screen.getByRole("heading", { level: 1, name: title })).not.toHaveAttribute(
      "aria-busy",
    );
  });
});
