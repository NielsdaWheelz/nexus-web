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
    end_position: absent(),
    tone: "Highlight",
    label: "Opening claim",
    preview: present("The claim under review."),
  },
  {
    id: "citation-early",
    kind: "SourceReference",
    item_id: "citation-early",
    position: 0.21,
    end_position: absent(),
    tone: "Citation",
    label: "Primary source",
    preview: absent(),
  },
  {
    id: "link-late",
    kind: "Link",
    item_id: "link-late",
    position: 0.8,
    end_position: absent(),
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
        structure={absent()}
        visibleRange={present({ start: 0.25, end: 0.5 })}
        currentPosition={absent()}
        scope={{ label: "document", start: 0, end: 1 }}
        onRevealCurrent={() => undefined}
        onActivateMarker={(marker) => setActivatedId(marker.id)}
      />
      <output aria-label="Activated destination">{activatedId}</output>
    </div>
  );
}

describe("document map overview rail in Chromium", () => {
  it("keeps every chapter at its source position across a document-wide chain of nearby marks", async () => {
    const chapters: ReaderDocumentMapMarker[] = Array.from({ length: 31 }, (_, index) => ({
      id: `chapter-${index}`,
      kind: "Contents",
      item_id: `contents:chapter-${index}`,
      position: index * 0.03,
      end_position: absent(),
      tone: "Neutral",
      label: `Chapter ${index + 1}`,
      preview: absent(),
    }));
    const view = (markers: ReaderDocumentMapMarker[]) => (
      <div style={{ height: 636 }}>
        <ReaderDocumentMapOverviewRail
          markers={markers}
          structure={absent()}
          visibleRange={present({ start: 0.25, end: 0.5 })}
          currentPosition={absent()}
          scope={{ label: "document", start: 0, end: 1 }}
          onRevealCurrent={() => undefined}
          onActivateMarker={() => undefined}
        />
      </div>
    );
    const { rerender } = render(view(chapters));

    const track = screen.getByRole("toolbar", { name: "Document Map destinations" });
    await waitFor(() => expect(
      within(track).getAllByRole("button").length,
      "transitive neighbors collapsed document-wide chapter structure",
    ).toBeGreaterThan(1));
    const ticks = await screen.findAllByTestId("reader-section-tick");
    expect(ticks).toHaveLength(chapters.length);
    const trackRect = track.getBoundingClientRect();
    expect(trackRect.height).toBe(600);
    for (const [index, tick] of ticks.entries()) {
      const rect = tick.getBoundingClientRect();
      expect((rect.top + rect.height / 2 - trackRect.top) / trackRect.height).toBeCloseTo(
        index * 0.03,
        3,
      );
    }
    expect(screen.queryByRole("button", { name: /31 destinations/ }), "transitive neighbors collapsed document-wide chapter structure").not.toBeInTheDocument();
    const controlsBeforeEvidence = within(track).getAllByRole("button").map((button) => ({
      name: button.getAttribute("aria-label"),
      top: button.getBoundingClientRect().top,
    }));
    for (const control of controlsBeforeEvidence) {
      const button = within(track).getByRole("button", { name: control.name! });
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    }
    rerender(view([...chapters, ...MARKERS]));
    for (const control of controlsBeforeEvidence) {
      expect(within(track).getByRole("button", { name: control.name! }).getBoundingClientRect().top).toBe(control.top);
    }
    expect(screen.getAllByTestId("reader-section-tick")).toHaveLength(chapters.length);
  });

  it("lets the exact current-position diamond disclose its structural collision without moving either mark", async () => {
    let revealed = false;
    render(
      <div style={{ height: 636 }}>
        <ReaderDocumentMapOverviewRail
          markers={[{ ...MARKERS[0]!, kind: "Contents", item_id: "contents:opening", label: "Opening", position: 0.2 }]}
          structure={absent()}
          visibleRange={present({ start: 0.201, end: 0.3 })}
          currentPosition={present(0.201)}
          scope={{ label: "document", start: 0, end: 1 }}
          onActivateMarker={() => undefined}
          onRevealCurrent={() => { revealed = true; }}
        />
      </div>,
    );
    const group = await screen.findByRole("button", { name: "2 destinations near 20% through document" });
    const diamond = screen.getByTestId("reader-current-position").getBoundingClientRect();
    const target = document.elementFromPoint(diamond.left + diamond.width / 2, diamond.top + diamond.height / 2);
    expect(group.contains(target)).toBe(true);
    fireEvent.click(group);
    fireEvent.click(screen.getByRole("button", { name: "Current position, 20% through document" }));
    expect(revealed).toBe(true);
  });

  it("clips an incoming highlight for local display while activation retains its original passage", async () => {
    const highlight = { ...MARKERS[0]!, position: 0.05, end_position: present(0.25) };
    let activated: ReaderDocumentMapMarker | null = null;
    render(
      <div style={{ height: 636 }}>
        <ReaderDocumentMapOverviewRail
          markers={[highlight]}
          structure={absent()}
          visibleRange={present({ start: 0.6, end: 0.7 })}
          currentPosition={present(0.6)}
          scope={{ label: "middle chapter", start: 0.1, end: 0.4 }}
          onActivateMarker={(marker) => { activated = marker; }}
          onRevealCurrent={() => undefined}
        />
      </div>,
    );
    const target = await screen.findByRole("button", { name: "Highlight: Opening claim, continues from before middle chapter" });
    const track = screen.getByRole("toolbar", { name: "Document Map destinations" }).getBoundingClientRect();
    const range = screen.getByTestId("reader-evidence-range").getBoundingClientRect();
    expect(range.top).toBeCloseTo(track.top, 1);
    expect(range.height / track.height).toBeCloseTo(0.5, 3);
    expect(screen.queryByTestId("reader-current-position")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reader-document-map-band")).not.toBeInTheDocument();
    fireEvent.click(target);
    expect(activated).toBe(highlight);
  });

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
