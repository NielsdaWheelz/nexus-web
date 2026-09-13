import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import "@/app/globals.css";
import { absent, present } from "@/lib/api/presence";
import type { ReaderDocumentMapMarker } from "@/lib/reader/documentMap";
import ReaderDocumentMapOverviewRail from "./ReaderDocumentMapOverviewRail";

const MARKERS: ReaderDocumentMapMarker[] = [
  {
    id: "highlight-early",
    kind: "Highlight",
    item_id: "highlight-early",
    position: 0.2,
    tone: "Highlight",
    label: "Opening claim",
    preview: present("The claim under review."),
  },
  {
    id: "citation-early",
    kind: "SourceReference",
    item_id: "citation-early",
    position: 0.21,
    tone: "Citation",
    label: "Primary source",
    preview: absent(),
  },
  {
    id: "link-late",
    kind: "Link",
    item_id: "link-late",
    position: 0.8,
    tone: "Link",
    label: "Related essay",
    preview: absent(),
  },
];

function RailHarness() {
  const [activatedId, setActivatedId] = useState("none");
  return (
    <div style={{ height: 400 }}>
      <ReaderDocumentMapOverviewRail
        markers={MARKERS}
        visibleRange={{ start: 0.25, end: 0.5 }}
        onActivateMarker={(marker) => setActivatedId(marker.id)}
      />
      <output aria-label="Activated destination">{activatedId}</output>
    </div>
  );
}

describe("document map overview rail in Chromium", () => {
  it("clusters nearby destinations while preserving navigation and activation", async () => {
    render(<RailHarness />);

    const cluster = await screen.findByRole("button", {
      name: "2 destinations near 21% through document",
    });
    const lateLink = screen.getByRole("button", {
      name: "Link: Related essay, 80% through document",
    });
    const track = screen.getByRole("toolbar", {
      name: "Document Map destinations",
    });
    const band = screen.getByTestId("reader-document-map-band");
    const trackRect = track.getBoundingClientRect();
    const bandRect = band.getBoundingClientRect();
    expect((bandRect.top - trackRect.top) / trackRect.height).toBeCloseTo(0.25);
    expect(bandRect.height / trackRect.height).toBeCloseTo(0.25);
    expect(cluster).toHaveAttribute("aria-expanded", "false");

    cluster.focus();
    fireEvent.keyDown(cluster, { key: "ArrowDown" });
    expect(lateLink).toHaveFocus();

    fireEvent.click(cluster);
    const destinations = screen.getByRole("list", {
      name: "2 destinations near 21% through document",
    });
    const highlight = within(destinations).getByRole("button", {
      name: "Highlight: Opening claim, 20% through document",
    });
    expect(highlight).toHaveFocus();

    fireEvent.keyDown(destinations, { key: "Escape" });
    await waitFor(() => expect(cluster).toHaveFocus());
    expect(
      screen.queryByRole("list", {
        name: "2 destinations near 21% through document",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(cluster);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Citation: Primary source, 21% through document",
      }),
    );
    expect(
      screen.getByRole("status", { name: "Activated destination" }),
    ).toHaveTextContent("citation-early");
  });
});
