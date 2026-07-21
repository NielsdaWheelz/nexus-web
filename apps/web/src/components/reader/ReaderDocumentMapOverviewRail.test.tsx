import { useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReaderDocumentMapMarker } from "@/lib/reader/documentMap";
import ReaderDocumentMapOverviewRail, {
  DOCUMENT_MAP_MARKER_MIN_GAP_PX,
} from "./ReaderDocumentMapOverviewRail";

const RAIL_HEIGHT = 400;

function marker(
  id: string,
  position: number,
  kind: ReaderDocumentMapMarker["kind"] = "Highlight",
): ReaderDocumentMapMarker {
  return {
    id,
    item_id: `${kind.toLowerCase()}:${id}`,
    kind,
    position,
    tone: kind === "SourceReference" ? "Citation" : "Highlight",
    label: `${kind} ${id}`,
    preview: { kind: "Present", value: `Preview ${id}` },
  };
}

function RailHarness({
  markers,
  onActivateMarker = () => {},
}: {
  markers: ReaderDocumentMapMarker[];
  onActivateMarker?: (marker: ReaderDocumentMapMarker) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  return (
    <div style={{ display: "flex", height: RAIL_HEIGHT }}>
      <div ref={contentRef} style={{ height: 1000, width: 200 }} />
      <ReaderDocumentMapOverviewRail
        markers={markers}
        contentRef={contentRef}
        documentSpan={{ start: 0, end: 1 }}
        onActivateMarker={onActivateMarker}
      />
    </div>
  );
}

describe("ReaderDocumentMapOverviewRail", () => {
  it("renders canonical typed markers without a generic map opener", async () => {
    render(
      <RailHarness
        markers={[
          marker("highlight:h1", 0.1),
          marker("source-reference:r1", 0.8, "SourceReference"),
        ]}
      />,
    );
    expect(
      screen.getByRole("region", { name: "Document Map overview" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId("reader-document-map-marker-highlight:h1"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Document Map" }),
    ).not.toBeInTheDocument();
  });

  it("activates the primary canonical marker object in a nearby cluster", async () => {
    const onActivateMarker = vi.fn();
    const primary = marker("highlight:h1", 0.5);
    const gapFraction = (DOCUMENT_MAP_MARKER_MIN_GAP_PX - 2) / RAIL_HEIGHT;
    render(
      <RailHarness
        markers={[
          primary,
          marker("source-reference:r1", 0.5 + gapFraction, "SourceReference"),
        ]}
        onActivateMarker={onActivateMarker}
      />,
    );
    const tick = await screen.findByTestId(
      "reader-document-map-marker-highlight:h1",
    );
    expect(tick).toHaveAccessibleName("2 Document Map markers");
    await userEvent.click(tick);
    await waitFor(() => expect(onActivateMarker).toHaveBeenCalledWith(primary));
  });
});
