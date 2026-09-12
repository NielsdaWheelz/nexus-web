import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

import { activityRecorder } from "@/lib/consumption/activityRecorder";
import { activityRuntime } from "@/lib/consumption/activityRuntime";
import type {
  ReaderDocumentProjection,
  ReaderSemanticViewport,
} from "@/lib/reader/readerDocumentPosition";
import type { ReaderResumeState } from "@/lib/reader/types";
import { useReaderActivityAdapter } from "./ReaderActivityAdapter";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000090";

function response404(): Response {
  return new Response(
    JSON.stringify({
      error: { code: "E_MEDIA_NOT_FOUND", message: "missing" },
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

function textLocator(kind: "web" | "transcript" | "epub"): ReaderResumeState {
  const locations = {
    text_offset: 0,
    progression: 0,
    total_progression: 0,
    position: 1,
  };
  const text = { quote: null, quote_prefix: null, quote_suffix: null };
  if (kind === "epub") {
    return {
      kind,
      target: { fragment_id: "fragment", href_path: "chapter.xhtml", anchor_id: { kind: "Absent" } },
      locations,
      text,
    };
  }
  return {
    kind,
    target: { fragment_id: "fragment" },
    locations,
    text,
  };
}

function Harness({
  mediaId,
  format,
  viewportKind,
  onGenuineInput,
}: {
  mediaId: string;
  format: "web" | "epub" | "transcript" | "pdf";
  viewportKind: "desktop" | "mobile";
  onGenuineInput: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pdf = format === "pdf";
  const documentProjection: ReaderDocumentProjection = pdf
    ? { kind: "Pdf", pageCount: 10 }
    : { kind: "Text", fragments: [{ fragmentId: "fragment", length: 100 }] };
  const primaryLocator: ReaderResumeState = pdf
    ? { kind: "pdf", page: 1, page_progression: 0, zoom: null, position: 1 }
    : textLocator(format);
  const semanticViewport: ReaderSemanticViewport = pdf
    ? {
        sourceKey: `${mediaId}:pdf:1`,
        layoutGeneration: 1,
        intent: "Restore",
        primaryLocator,
        visibleStart: { kind: "Pdf", page: 1, pageFraction: 0 },
        visibleEnd: { kind: "Pdf", page: 1, pageFraction: 1 },
        atEnd: false,
      }
    : {
        sourceKey: `${mediaId}:${format}:fragment`,
        layoutGeneration: 1,
        intent: "Restore",
        primaryLocator,
        visibleStart: { kind: "Text", fragmentId: "fragment", offset: 0 },
        visibleEnd: { kind: "Text", fragmentId: "fragment", offset: 50 },
        atEnd: false,
      };
  useReaderActivityAdapter({
    mediaId,
    observerKey: `${format}:${viewportKind}`,
    canRead: true,
    paneActive: true,
    viewport: { hydrated: true, kind: viewportKind },
    activityRootRef: rootRef,
    activeContent: pdf
      ? null
      : {
          fragmentId: "fragment",
          canonicalText: "one two three four five six seven eight nine ten",
          documentWordStart: 0,
        },
    semanticViewport,
    documentProjection,
    onGenuineReaderInput: onGenuineInput,
    previewLease: {
      isActive: () => false,
      subscribe: () => () => undefined,
    },
  });
  return <div ref={rootRef} data-testid="activity-root" tabIndex={0}>Reader</div>;
}

afterEach(() => vi.unstubAllGlobals());

describe("format-neutral reader activity", () => {
  it("records the first genuine post-restore gesture for every format and viewport", async () => {
    const requests: Array<{
      mediaRef: string;
      deviceClass: "Desktop" | "Mobile";
      batch: { modality: string };
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return response404();
      }),
    );
    const runtime = activityRuntime();
    await runtime.open(ACCOUNT_ID);
    activityRecorder().setCaptureReady(true);

    const view = render(
      <Harness
        mediaId="20000000-0000-4000-8000-000000000090"
        format="web"
        viewportKind="desktop"
        onGenuineInput={vi.fn()}
      />,
    );
    view.unmount();
    expect(requests).toHaveLength(0);

    const cases = (["web", "epub", "transcript", "pdf"] as const).flatMap(
      (format) =>
        (["desktop", "mobile"] as const).map((viewportKind) => ({
          format,
          viewportKind,
        })),
    );
    for (const [index, candidate] of cases.entries()) {
      const onGenuineInput = vi.fn();
      const mediaId = `20000000-0000-4000-8000-${String(index + 91).padStart(12, "0")}`;
      const view = render(
        <Harness
          mediaId={mediaId}
          format={candidate.format}
          viewportKind={candidate.viewportKind}
          onGenuineInput={onGenuineInput}
        />,
      );
      await userEvent.click(screen.getByTestId("activity-root"));
      view.unmount();
      await vi.waitFor(() => expect(requests).toHaveLength(index + 1));
      expect(onGenuineInput).toHaveBeenCalled();
      expect(requests[index]).toMatchObject({
        mediaRef: `media:${mediaId}`,
        deviceClass: candidate.viewportKind === "mobile" ? "Mobile" : "Desktop",
        batch: { modality: "Reading" },
      });
    }

    activityRecorder().setCaptureReady(false);
    await runtime.discardFailed();
  });
});
