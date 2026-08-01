import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { useReaderActivityAdapter } from "./ReaderActivityAdapter";
import { createMediaFindPreviewLease } from "./mediaFindPreviewLease";

const recorder = vi.hoisted(() => ({
  observe: vi.fn(),
  registerObserver: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/consumption/activityRecorder", () => ({
  activityRecorder: () => recorder,
}));

function latestReadingObservation() {
  const observations = recorder.observe.mock.calls as unknown as Array<
    [
      string,
      {
        modality: string;
        eligible: boolean;
        idleUntilMono?: number;
        measurement: { progress?: number; wordPosition?: number };
      },
    ]
  >;
  const call = observations
    .map(([, observation]) => observation)
    .filter((observation) => observation.modality === "Reading")
    .at(-1);
  if (!call) throw new Error("Reading observer was not updated");
  return call;
}

function ReaderHarness({
  isPdf = false,
  paneActive = true,
  totalProgression = 0.25,
  intent = "Reader",
  previewLease = {
    isActive: () => false,
    subscribe: () => () => {},
  },
  onGenuineReaderInput = () => {},
}: {
  isPdf?: boolean;
  paneActive?: boolean;
  totalProgression?: number;
  intent?: "Reader" | "Restore" | "Preview" | "Return";
  previewLease?: {
    isActive(): boolean;
    subscribe(listener: () => void): () => void;
  };
  onGenuineReaderInput?: () => void;
}) {
  const readerRootRef = useRef<HTMLDivElement>(null);
  const pdfViewportRef = useRef<HTMLDivElement>(null);
  const pdfContentRef = useRef<HTMLDivElement>(null);
  const { noteGenuineInput } = useReaderActivityAdapter({
    mediaId: "00000000-0000-4000-8000-000000000702",
    observerKey: "reader:activity-test",
    canRead: true,
    paneActive,
    viewport: { hydrated: true, kind: "desktop" },
    readerRootRef,
    pdfViewportRef,
    activeContent: isPdf
      ? null
      : {
          fragmentId: "fragment-a",
          canonicalText: "reader fixture!!",
          documentWordStart: 10,
        },
    documentProjection: isPdf
      ? { kind: "Pdf", pageCount: 4 }
      : {
          kind: "Text",
          fragments: [{ fragmentId: "fragment-a", length: 16 }],
        },
    semanticViewport: isPdf
      ? {
          sourceKey: "pdf-source",
          layoutGeneration: 1,
          intent,
          primaryLocator: {
            kind: "pdf",
            page: 2,
            page_progression: null,
            zoom: 1,
            position: 2,
          },
          visibleStart: { kind: "Pdf", page: 2, pageFraction: 0 },
          visibleEnd: { kind: "Pdf", page: 2, pageFraction: 0.5 },
          atEnd: false,
        }
      : {
          sourceKey: "text-source",
          layoutGeneration: 1,
          intent,
          primaryLocator: {
            kind: "web",
            target: { fragment_id: "fragment-a" },
            locations: {
              text_offset: totalProgression * 16,
              progression: totalProgression,
              total_progression: totalProgression,
              position: null,
            },
            text: { quote: null, quote_prefix: null, quote_suffix: null },
          },
          visibleStart: {
            kind: "Text",
            fragmentId: "fragment-a",
            offset: totalProgression * 16,
          },
          visibleEnd: {
            kind: "Text",
            fragmentId: "fragment-a",
            offset: Math.min(16, totalProgression * 16 + 4),
          },
          atEnd: false,
        },
    onGenuineReaderInput,
    previewLease,
  });
  return (
    <>
      {isPdf ? (
        <div
          ref={pdfViewportRef}
          data-testid="reader-root"
          role="region"
          aria-label="PDF document"
          tabIndex={-1}
        >
          <div ref={pdfContentRef} data-testid="pdf-content">
            Reader
          </div>
        </div>
      ) : (
        <div ref={readerRootRef} data-testid="reader-root" tabIndex={0}>
          Reader
        </div>
      )}
      <button type="button" onClick={noteGenuineInput}>
        Trusted viewport intent
      </button>
    </>
  );
}

describe("useReaderActivityAdapter", () => {
  beforeEach(() => {
    recorder.observe.mockReset();
    recorder.registerObserver.mockReset();
    recorder.registerObserver.mockImplementation(() => vi.fn());
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requires genuine input and closes on pane, visibility, and focus loss", async () => {
    const { rerender } = render(<ReaderHarness />);
    const root = screen.getByTestId("reader-root");
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(false));

    fireEvent.pointerDown(root);
    expect(latestReadingObservation().eligible).toBe(false);

    await userEvent.click(root);
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(true));
    expect(latestReadingObservation().idleUntilMono).toEqual(expect.any(Number));

    rerender(<ReaderHarness paneActive={false} />);
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(false));

    rerender(<ReaderHarness />);
    await userEvent.click(root);
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(true));
    let visibilityState: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(false));

    visibilityState = "visible";
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(false));
  });

  it("preserves recent genuine input across measurement dependency churn", async () => {
    const { rerender } = render(<ReaderHarness />);
    const root = screen.getByTestId("reader-root");
    await userEvent.click(root);
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(true));

    rerender(<ReaderHarness totalProgression={0.5} />);

    await waitFor(() => expect(latestReadingObservation().eligible).toBe(true));
    expect(latestReadingObservation().measurement.progress).toBe(0.5);
  });

  it("takes text scroll activity only from the shared trusted viewport path", async () => {
    render(<ReaderHarness />);
    const root = screen.getByTestId("reader-root");

    fireEvent.wheel(root, { deltaY: 10 });
    expect(latestReadingObservation().eligible).toBe(false);

    await userEvent.click(
      screen.getByRole("button", { name: "Trusted viewport intent" }),
    );
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(true));
    expect(latestReadingObservation().measurement.progress).toBe(0.25);
  });

  it("becomes ineligible immediately while previewing and releases on reader pointer input", async () => {
    const previewLease = createMediaFindPreviewLease();
    const release = vi.spyOn(previewLease, "releaseForGenuineInput");
    render(
      <ReaderHarness
        previewLease={previewLease}
        onGenuineReaderInput={() => previewLease.releaseForGenuineInput()}
      />,
    );
    const root = screen.getByTestId("reader-root");

    await userEvent.click(
      screen.getByRole("button", { name: "Trusted viewport intent" }),
    );
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(true));

    previewLease.acquire();
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(false));

    await userEvent.click(root);
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(true));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("publishes PDF progression without a word position", async () => {
    render(<ReaderHarness isPdf />);
    const root = screen.getByTestId("reader-root");
    await userEvent.click(root);

    await waitFor(() => expect(latestReadingObservation().eligible).toBe(true));
    expect(latestReadingObservation().measurement).toEqual({
      progress: 0.25,
      wordPosition: undefined,
    });
  });

  it("keeps restore snapshots ineligible even after genuine input", async () => {
    render(<ReaderHarness intent="Restore" />);
    await userEvent.click(screen.getByTestId("reader-root"));

    await waitFor(() => expect(latestReadingObservation().eligible).toBe(false));
    expect(latestReadingObservation().measurement.progress).toBe(0.25);
  });

  it("owns trusted PDF keyboard activity on the scrolling viewport", async () => {
    const previewLease = createMediaFindPreviewLease();
    const release = vi.spyOn(previewLease, "releaseForGenuineInput");
    previewLease.acquire();
    render(
      <ReaderHarness
        isPdf
        previewLease={previewLease}
        onGenuineReaderInput={() =>
          previewLease.releaseForGenuineInput()
        }
      />,
    );

    const viewport = screen.getByRole("region", { name: "PDF document" });
    const content = screen.getByTestId("pdf-content");
    expect(viewport).toContainElement(content);
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(false));

    fireEvent.keyDown(content, { key: "PageDown" });
    expect(release).not.toHaveBeenCalled();
    expect(latestReadingObservation().eligible).toBe(false);

    viewport.focus({ preventScroll: true });
    await userEvent.keyboard("{PageDown}");

    await waitFor(() => expect(release).toHaveBeenCalledOnce());
    await waitFor(() => expect(latestReadingObservation().eligible).toBe(true));
  });
});
