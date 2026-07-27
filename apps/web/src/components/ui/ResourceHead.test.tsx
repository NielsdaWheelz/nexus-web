import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ResourceHead from "./ResourceHead";

describe("ResourceHead", () => {
  it("renders two desktop credits in group order and omits the hidden tail", () => {
    render(
      <ResourceHead
        id="resource-heading"
        maxVisibleCredits={2}
        resource={{
          status: "ready",
          title: "The Left Hand of Darkness",
          creditGroups: [
            {
              kind: "authors",
              credits: [
                { label: "Ursula K. Le Guin", href: "/authors/ursula" },
              ],
            },
            {
              kind: "role",
              label: "Translator",
              credits: [
                { label: "Margaret Chodos-Irvine", href: "/authors/margaret" },
                { label: "Hidden Translator", href: "/authors/hidden" },
              ],
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
    expect(screen.getByText("Authors:")).toHaveClass("sr-only");
    expect(screen.getByText("Translator:")).toBeVisible();

    const author = screen.getByRole("link", { name: "Ursula K. Le Guin" });
    expect(author).toHaveAttribute("href", "/authors/ursula");
    expect(author).toHaveAttribute("title", "Ursula K. Le Guin");
    expect(author).toHaveAttribute("dir", "auto");
    expect(author).toHaveAttribute("data-pane-label-hint", "Ursula K. Le Guin");

    const translator = screen.getByRole("link", {
      name: "Margaret Chodos-Irvine",
    });
    expect(translator).toHaveAttribute("href", "/authors/margaret");
    expect(
      screen.getAllByRole("link").map((link) => link.textContent),
    ).toEqual(["Ursula K. Le Guin", "Margaret Chodos-Irvine"]);
    expect(screen.getByText("·")).toBeVisible();
    expect(screen.queryByText("Hidden Translator")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Hidden Translator" }),
    ).toBeNull();
    expect(screen.getByText("+1")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("1 more credits")).toHaveClass("sr-only");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders comma-separated credits and a noninteractive exact hidden count", () => {
    render(
      <ResourceHead
        id="resource-heading"
        maxVisibleCredits={2}
        resource={{
          status: "ready",
          title: "The Left Hand of Darkness",
          creditGroups: [
            {
              kind: "authors",
              credits: [
                { label: "Ursula K. Le Guin", href: "/authors/ursula" },
                { label: "Brian Attebery", href: "/authors/brian" },
                { label: "Third Author", href: "/authors/third" },
              ],
            },
            {
              kind: "role",
              label: "Translator",
              credits: [
                { label: "Hidden Translator", href: "/authors/hidden" },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText(",")).toBeVisible();
    expect(screen.getByText("+2")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("2 more credits")).toHaveClass("sr-only");
    expect(screen.queryByText("Third Author")).not.toBeInTheDocument();
    expect(screen.queryByText("Translator:")).not.toBeInTheDocument();
  });

  it("renders one mobile credit and keeps unresolved credit facts as text", () => {
    render(
      <ResourceHead
        id="resource-heading"
        maxVisibleCredits={1}
        resource={{
          status: "ready",
          title: "Unresolved Work",
          creditGroups: [
            {
              kind: "role",
              label: "Narrator",
              credits: [
                { label: "Anonymous Preview" },
                { label: "Resolved Narrator", href: "/authors/resolved" },
              ],
            },
          ],
        }}
      />,
    );

    const unresolved = screen.getByTitle("Anonymous Preview");
    expect(unresolved).toHaveAttribute("title", "Anonymous Preview");
    expect(unresolved).toHaveAttribute("dir", "auto");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Resolved Narrator")).not.toBeInTheDocument();
    expect(screen.getByText("+1")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("1 more credits")).toHaveClass("sr-only");
    expect(screen.getByText("Narrator:")).toBeVisible();
  });

  it("keeps a named busy heading while pending", () => {
    render(
      <ResourceHead
        id="pending-heading"
        maxVisibleCredits={2}
        resource={{ status: "pending", accessibleLabel: "Loading media…" }}
      />,
    );

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Loading media…",
    });
    expect(heading).toHaveAttribute("aria-busy", "true");
    expect(heading).toHaveAttribute("id", "pending-heading");
  });

  it.each([
    { status: "unavailable" as const, title: "Media unavailable" },
    { status: "failed" as const, title: "Media failed to load" },
  ])("renders the $status title without a busy state", ({ status, title }) => {
    render(
      <ResourceHead
        id={`${status}-heading`}
        maxVisibleCredits={2}
        resource={{ status, title }}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: title }),
    ).not.toHaveAttribute("aria-busy");
  });
});
