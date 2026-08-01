import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReaderDocumentMapMarker } from "@/lib/reader/documentMap";
import ReaderDocumentMapOverviewRail from "./ReaderDocumentMapOverviewRail";

const RAIL_HEIGHT = 400;

function marker({
  id,
  position,
  kind = "Highlight",
  tone,
  label = `Destination ${id}`,
  preview = `Excerpt ${id}`,
}: {
  id: string;
  position: number;
  kind?: ReaderDocumentMapMarker["kind"];
  tone?: ReaderDocumentMapMarker["tone"];
  label?: string;
  preview?: string | null;
}): ReaderDocumentMapMarker {
  return {
    id,
    item_id: `${kind.toLowerCase()}:${id}`,
    kind,
    position,
    tone:
      tone ??
      (kind === "SourceReference" || kind === "GeneratedCitation"
        ? "Citation"
        : kind === "Highlight" || kind === "Link" || kind === "Synapse"
          ? kind
          : "Neutral"),
    label,
    preview:
      preview === null
        ? { kind: "Absent" }
        : { kind: "Present", value: preview },
  };
}

function RailHarness({
  markers,
  visibleRange = { start: 0.2, end: 0.4 },
  onActivateMarker = () => {},
  height = RAIL_HEIGHT,
}: {
  markers: ReaderDocumentMapMarker[];
  visibleRange?: { start: number; end: number };
  onActivateMarker?: (marker: ReaderDocumentMapMarker) => void;
  height?: number;
}) {
  return (
    <div style={{ display: "flex", height }}>
      <ReaderDocumentMapOverviewRail
        markers={markers}
        visibleRange={visibleRange}
        onActivateMarker={onActivateMarker}
      />
    </div>
  );
}

describe("ReaderDocumentMapOverviewRail", () => {
  it("names typed destinations without color or a generic map opener and keeps every target at least 24px", async () => {
    render(
      <RailHarness
        markers={[
          marker({ id: "contents", position: 0.05, kind: "Contents" }),
          marker({
            id: "embed",
            position: 0.2,
            kind: "Embed",
            tone: "Warning",
          }),
          marker({ id: "highlight", position: 0.35 }),
          marker({
            id: "source",
            position: 0.5,
            kind: "SourceReference",
          }),
          marker({
            id: "generated",
            position: 0.65,
            kind: "GeneratedCitation",
          }),
          marker({ id: "link", position: 0.8, kind: "Link" }),
          marker({ id: "synapse", position: 0.95, kind: "Synapse" }),
        ]}
      />,
    );

    const rail = screen.getByRole("region", {
      name: "Document Map overview",
    });
    expect(rail).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Companion" }),
    ).not.toBeInTheDocument();

    const expectedNames = [
      "Contents: Destination contents, 5% through document",
      "Embed: Destination embed, 20% through document",
      "Highlight: Destination highlight, 35% through document",
      "Citation: Destination source, 50% through document",
      "Citation: Destination generated, 65% through document",
      "Link: Destination link, 80% through document",
      "Synapse: Destination synapse, 95% through document",
    ];
    for (const name of expectedNames) {
      const destination = await screen.findByRole("button", { name });
      const bounds = destination.getBoundingClientRect();
      expect(bounds.width).toBeGreaterThanOrEqual(24);
      expect(bounds.height).toBeGreaterThanOrEqual(24);
    }

    screen.getByRole("button", { name: expectedNames[2] }).focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Highlight: Destination highlight",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("Excerpt highlight");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "35% through document",
    );
  });

  it("paints the supplied semantic viewport range without reading scroll geometry", async () => {
    render(
      <RailHarness
        markers={[marker({ id: "one", position: 0.5 })]}
        visibleRange={{ start: 0.25, end: 0.7 }}
      />,
    );

    const track = screen.getByRole("toolbar", {
      name: "Document Map destinations",
    });
    const band = screen.getByTestId("reader-document-map-band");
    await waitFor(() =>
      expect(track.getBoundingClientRect().height).toBeGreaterThan(0),
    );

    const trackBounds = track.getBoundingClientRect();
    const bandBounds = band.getBoundingClientRect();
    expect(bandBounds.top - trackBounds.top).toBeCloseTo(
      trackBounds.height * 0.25,
      1,
    );
    expect(bandBounds.height).toBeCloseTo(trackBounds.height * 0.45, 1);
  });

  it("clusters targets separated by 23px but leaves targets separated by 25px independent", async () => {
    const { rerender } = render(<RailHarness markers={[]} />);
    const track = screen.getByRole("toolbar", {
      name: "Document Map destinations",
    });
    await waitFor(() =>
      expect(track.getBoundingClientRect().height).toBeGreaterThan(0),
    );
    const trackHeight = track.getBoundingClientRect().height;
    const closeStart = marker({ id: "close-start", position: 0.2 });
    const closeEnd = marker({
      id: "close-end",
      position: 0.2 + 23 / trackHeight,
      kind: "SourceReference",
    });
    const separateStart = marker({
      id: "separate-start",
      position: 0.7,
      kind: "Link",
    });
    const separateEnd = marker({
      id: "separate-end",
      position: 0.7 + 25 / trackHeight,
      kind: "Synapse",
    });

    rerender(
      <RailHarness
        markers={[closeStart, closeEnd, separateStart, separateEnd]}
      />,
    );

    await waitFor(() =>
      expect(within(track).getAllByRole("button")).toHaveLength(3),
    );
    expect(within(track).getAllByRole("button")[0]).toHaveAccessibleName(
      /2 destinations/,
    );
    expect(
      within(track).getByRole("button", {
        name: destinationName(separateStart),
      }),
    ).toBeInTheDocument();
    expect(
      within(track).getByRole("button", {
        name: destinationName(separateEnd),
      }),
    ).toBeInTheDocument();
  });

  it("reclusters after a container-only height change", async () => {
    const closeMarkers = [
      marker({ id: "first", position: 0.4 }),
      marker({ id: "second", position: 0.45, kind: "SourceReference" }),
    ];
    const { rerender } = render(
      <RailHarness markers={closeMarkers} height={400} />,
    );
    const track = screen.getByRole("toolbar", {
      name: "Document Map destinations",
    });
    await waitFor(() =>
      expect(within(track).getAllByRole("button")).toHaveLength(1),
    );

    rerender(<RailHarness markers={closeMarkers} height={600} />);

    await waitFor(() =>
      expect(within(track).getAllByRole("button")).toHaveLength(2),
    );
  });

  it("opens every median-positioned destination in an overlapping cluster and activates the chosen member", async () => {
    const onActivateMarker = vi.fn();
    const highlight = marker({ id: "highlight", position: 0.41 });
    const citation = marker({
      id: "citation",
      position: 0.46,
      kind: "SourceReference",
    });
    const link = marker({ id: "link", position: 0.5, kind: "Link" });
    render(
      <RailHarness
        markers={[highlight, citation, link]}
        onActivateMarker={onActivateMarker}
      />,
    );

    const track = screen.getByRole("toolbar", {
      name: "Document Map destinations",
    });
    const cluster = await screen.findByRole("button", {
      name: "3 destinations near 46% through document",
    });
    const trackBounds = track.getBoundingClientRect();
    const clusterBounds = cluster.getBoundingClientRect();
    expect(clusterBounds.top + clusterBounds.height / 2).toBeCloseTo(
      trackBounds.top + trackBounds.height * 0.46,
      1,
    );

    await userEvent.click(cluster);

    expect(onActivateMarker).not.toHaveBeenCalled();
    const list = screen.getByRole("list", {
      name: "3 destinations near 46% through document",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(list).getByRole("button", {
        name: "Highlight: Destination highlight, 41% through document",
      }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", {
        name: "Citation: Destination citation, 46% through document",
      }),
    ).toBeInTheDocument();
    const linkDestination = within(list).getByRole("button", {
      name: "Link: Destination link, 50% through document",
    });

    await userEvent.click(linkDestination);
    expect(onActivateMarker).toHaveBeenCalledOnce();
    expect(onActivateMarker).toHaveBeenCalledWith(link);
  });

  it("uses roving rail focus and returns focus from a cluster on Escape", async () => {
    const onActivateMarker = vi.fn();
    const start = marker({ id: "start", position: 0.1, kind: "Contents" });
    const clusterMembers = [
      marker({ id: "highlight", position: 0.4 }),
      marker({
        id: "citation",
        position: 0.44,
        kind: "SourceReference",
      }),
    ];
    const end = marker({ id: "end", position: 0.9, kind: "Embed" });
    render(
      <RailHarness
        markers={[start, ...clusterMembers, end]}
        onActivateMarker={onActivateMarker}
      />,
    );

    const toolbar = screen.getByRole("toolbar", {
      name: "Document Map destinations",
    });
    const [startButton, clusterButton, endButton] =
      within(toolbar).getAllByRole("button");
    expect(startButton).toHaveAttribute("tabindex", "0");
    expect(clusterButton).toHaveAttribute("tabindex", "-1");
    expect(endButton).toHaveAttribute("tabindex", "-1");

    startButton!.focus();
    await userEvent.keyboard("{Enter}");
    expect(onActivateMarker).toHaveBeenLastCalledWith(start);

    await userEvent.keyboard("{ArrowDown} ");
    expect(
      screen.getByRole("list", {
        name: "2 destinations near 42% through document",
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Highlight: Destination highlight, 40% through document",
        }),
      ).toHaveFocus(),
    );

    await userEvent.keyboard("{Escape}");
    expect(clusterButton).toHaveFocus();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();

    await userEvent.keyboard("{End}");
    expect(endButton).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(startButton).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown} ");
    expect(endButton).toHaveFocus();
    expect(onActivateMarker).toHaveBeenLastCalledWith(end);
  });
});

function destinationName(marker: ReaderDocumentMapMarker): string {
  const type =
    marker.kind === "SourceReference" || marker.kind === "GeneratedCitation"
      ? "Citation"
      : marker.kind;
  return `${type}: ${marker.label}, ${Math.round(marker.position * 100)}% through document`;
}
