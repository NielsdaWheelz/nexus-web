import { useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ReaderDocumentMapOverviewRail, {
  DOCUMENT_MAP_MARKER_MIN_GAP_PX,
} from "./ReaderDocumentMapOverviewRail";
import type { ReaderDocumentMapMarker } from "@/lib/reader/documentMap";

const RAIL_HEIGHT = 400;

function marker(
  id: string,
  position: number,
  lens_id: ReaderDocumentMapMarker["lens_id"] = "highlights",
): ReaderDocumentMapMarker {
  return {
    id,
    item_id: `${lens_id}:${id}`,
    lens_id,
    lane: lens_id,
    position,
    status: "exact",
    tone: lens_id === "citations" ? "citation" : "highlight",
    label: `${lens_id} ${id}`,
    preview: `Preview ${id}`,
  };
}

function RailHarness({
  markers,
  onActivateMarker = () => {},
  onOpenMap = () => {},
}: {
  markers: ReaderDocumentMapMarker[];
  onActivateMarker?: (itemId: string, lensId: ReaderDocumentMapMarker["lens_id"]) => void;
  onOpenMap?: () => void;
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
        onOpenMap={onOpenMap}
      />
    </div>
  );
}

describe("ReaderDocumentMapOverviewRail", () => {
  it("renders typed Document Map markers and opens the map", async () => {
    const user = userEvent.setup();
    const onOpenMap = vi.fn();
    render(
      <RailHarness
        markers={[marker("h1", 0.1), marker("c1", 0.8, "citations")]}
        onOpenMap={onOpenMap}
      />,
    );

    expect(screen.getByRole("region", { name: "Document Map overview" })).toBeTruthy();
    expect(await screen.findByTestId("reader-document-map-marker-h1")).toBeTruthy();
    expect(screen.getByTestId("reader-document-map-marker-c1")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Open Document Map" }));
    expect(onOpenMap).toHaveBeenCalledTimes(1);
  });

  it("activates the first marker in a nearby cluster with its lens id", async () => {
    const user = userEvent.setup();
    const onActivateMarker = vi.fn();
    const gapFraction = (DOCUMENT_MAP_MARKER_MIN_GAP_PX - 2) / RAIL_HEIGHT;
    render(
      <RailHarness
        markers={[
          marker("h1", 0.5, "highlights"),
          marker("c1", 0.5 + gapFraction, "citations"),
        ]}
        onActivateMarker={onActivateMarker}
      />,
    );

    const tick = await screen.findByTestId("reader-document-map-marker-h1");
    expect(tick).toHaveAccessibleName("2 Document Map markers");

    await user.click(tick);
    await waitFor(() => {
      expect(onActivateMarker).toHaveBeenCalledWith("highlights:h1", "highlights");
    });
  });
});
