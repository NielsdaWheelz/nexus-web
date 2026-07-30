import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PodcastReplacementDialog from "./PodcastReplacementDialog";

describe("PodcastReplacementDialog", () => {
  const conflicts = [
    { libraryId: "lib-a", libraryName: "Reading List", episodeCount: 2 },
    { libraryId: "lib-b", libraryName: "Favorites", episodeCount: 1 },
  ];

  it("states the total, each library's count, and the irreversible-compaction consequence", () => {
    render(
      <PodcastReplacementDialog
        open
        conflicts={conflicts}
        busy={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Replace episode placements?" }),
    ).toBeInTheDocument();
    // Total across both libraries.
    expect(
      screen.getByText(/replace 3 directly filed episodes/i),
    ).toBeInTheDocument();
    // Per-library names + counts, with correct pluralization.
    expect(screen.getByText(/Reading List · 2 episodes/)).toBeInTheDocument();
    expect(screen.getByText(/Favorites · 1 episode\b/)).toBeInTheDocument();
    // AC10 / §6.2: the compaction consequence is stated.
    expect(
      screen.getByText(/will not be restored if the Podcast is removed later/i),
    ).toBeInTheDocument();
  });

  it("singularizes the total for a single conflicting episode", () => {
    render(
      <PodcastReplacementDialog
        open
        conflicts={[
          { libraryId: "lib-a", libraryName: "Reading List", episodeCount: 1 },
        ]}
        busy={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/replace 1 directly filed episode\b/i),
    ).toBeInTheDocument();
  });

  it("confirms and cancels through distinct buttons and disables Cancel while busy", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <PodcastReplacementDialog
        open
        conflicts={conflicts}
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Replace and subscribe" }),
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(
      <PodcastReplacementDialog
        open
        conflicts={conflicts}
        busy
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("renders nothing when closed", () => {
    render(
      <PodcastReplacementDialog
        open={false}
        conflicts={conflicts}
        busy={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("dialog", { name: "Replace episode placements?" }),
    ).not.toBeInTheDocument();
  });
});
