import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import ReaderCitation from "@/components/ui/ReaderCitation";
import type { ReaderCitationPreview } from "@/lib/conversations/readerCitation";

function renderCitation(preview: ReaderCitationPreview) {
  return render(
    <ReaderCitation
      index={1}
      color="yellow"
      preview={preview}
      target={null}
      href="/media/media-1"
      onActivate={vi.fn()}
    />,
  );
}

describe("ReaderCitation summary abstract", () => {
  it("shows the per-media summary abstract on hover when present", async () => {
    const user = userEvent.setup();
    renderCitation({
      title: "Source title",
      summary: "A concise per-media abstract.",
      excerpt: "matched source text",
    });

    await user.hover(screen.getByRole("link", { name: "Open citation 1" }));

    await waitFor(() => {
      expect(
        screen.getByText("A concise per-media abstract."),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("matched source text")).toBeInTheDocument();
  });

  it("renders nothing for the abstract when summary is absent", async () => {
    const user = userEvent.setup();
    renderCitation({
      title: "Source title",
      excerpt: "matched source text",
    });

    await user.hover(screen.getByRole("link", { name: "Open citation 1" }));

    await waitFor(() => {
      expect(screen.getByText("matched source text")).toBeInTheDocument();
    });
    expect(screen.queryByText(/abstract/i)).not.toBeInTheDocument();
  });
});
