import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import type { DocentWalkState } from "@/lib/conversations/docentWalk";
import DocentOverlay from "./DocentOverlay";

function idleWalk(): DocentWalkState {
  return { steps: [], index: 0, status: "idle", epoch: 0 };
}

function activeWalk(
  index: number,
  steps: DocentWalkState["steps"],
): DocentWalkState {
  return { steps, index, status: "active", epoch: 1 };
}

const STEPS: DocentWalkState["steps"] = [
  {
    ordinal: 1,
    title: "Capital in the Twenty-First Century",
    href: "/media/m1#evidence-span-1",
    citingSentence: "The evidence for secular stagnation is strongest [1].",
  },
  {
    ordinal: 2,
    title: "Second Source",
    href: "/media/m2#evidence-span-2",
    citingSentence: "Another claim [2] is made here.",
  },
];

const NULL_STEP: DocentWalkState["steps"][0] = {
  ordinal: 3,
  title: "Deleted Source",
  href: null,
  citingSentence: null,
};

describe("DocentOverlay", () => {
  it("renders nothing when walk is idle", () => {
    render(
      <DocentOverlay
        walk={idleWalk()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("docent-overlay")).not.toBeInTheDocument();
  });

  it("renders step counter and title when active", () => {
    render(
      <DocentOverlay
        walk={activeWalk(0, STEPS)}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    expect(screen.getByTestId("docent-overlay")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByText("Capital in the Twenty-First Century")).toBeInTheDocument();
  });

  it("shows citing sentence in machine register", () => {
    render(
      <DocentOverlay
        walk={activeWalk(0, STEPS)}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    expect(
      screen.getByText("The evidence for secular stagnation is strongest [1]."),
    ).toBeInTheDocument();
  });

  it("does not echo the title when the citing sentence is null (spec R-2)", () => {
    const step: DocentWalkState["steps"][0] = {
      ordinal: 1,
      title: "Routable But No Sentence",
      href: "/media/m9#evidence-span-9",
      citingSentence: null,
    };
    render(
      <DocentOverlay
        walk={activeWalk(0, [step])}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    // Title appears exactly once (in the header), not duplicated into the
    // machine-register sentence row.
    expect(screen.getAllByText("Routable But No Sentence")).toHaveLength(1);
  });

  it("disables prev at index 0", () => {
    render(
      <DocentOverlay
        walk={activeWalk(0, STEPS)}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    const prevBtn = screen.getByRole("button", { name: "Previous source" });
    expect(prevBtn).toBeDisabled();
  });

  it("shows struck-through title and 'Source unavailable' for null-href step", () => {
    render(
      <DocentOverlay
        walk={activeWalk(0, [NULL_STEP])}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    // aria-label on <s> covers accessibility
    expect(screen.getByLabelText("Source unavailable")).toBeInTheDocument();
    // visible "Source unavailable" text
    expect(screen.getByText("Source unavailable")).toBeInTheDocument();
  });

  it("calls onNext when next button is clicked", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    render(
      <DocentOverlay
        walk={activeWalk(0, STEPS)}
        onNext={onNext}
        onPrev={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Next source" }));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("calls onLeave when Leave button is clicked", async () => {
    const user = userEvent.setup();
    const onLeave = vi.fn();
    render(
      <DocentOverlay
        walk={activeWalk(0, STEPS)}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onLeave={onLeave}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Leave walk" }));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("has aria-live=polite on the announcement region", () => {
    render(
      <DocentOverlay
        walk={activeWalk(0, STEPS)}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    expect(screen.getByTestId("docent-header")).toHaveAttribute("aria-live", "polite");
  });
});
