import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { expect, it } from "vitest";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { clearPendingReaderPulse, consumePendingReaderPulse, dispatchReaderPulse } from "@/lib/reader/pulseEvent";
import { ResourceCache } from "@/lib/api/resourceCache";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import type { ReaderPulseTarget } from "@/lib/reader/pulseEvent";
import { useReaderTarget } from "@/lib/reader/useReaderTarget";
import { assumePaneVisitId } from "@/lib/workspace/schema";

const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const noop = () => {};

function ReaderRuntime({
  mediaId,
  paneId = `pane-${mediaId}`,
  href = `/media/${mediaId}`,
  onReplacePane = noop,
  children,
}: {
  mediaId: string;
  paneId?: string;
  href?: string;
  onReplacePane?: Parameters<typeof PaneRuntimeProvider>[0]["onReplacePane"];
  children: ReactNode;
}) {
  return (
    <PaneRuntimeProvider
      paneId={paneId}
      visitId={VISIT_ID}
      isActive
      href={href}
      routeId="media"
      canGoBack={false}
      canGoForward={false}
      onNavigatePane={noop}
      onReplacePane={onReplacePane}
      onActivateWorkspaceTarget={() => ({
        kind: "ActivatedExisting",
        paneId,
      })}
      onGoBackPane={noop}
      onGoForwardPane={noop}
    >
      {children}
    </PaneRuntimeProvider>
  );
}

function ReaderTargetProbe({ mediaId, paneId = `pane-${mediaId}` }: { mediaId: string; paneId?: string }) {
  const { status, target, markActive } = useReaderTarget(mediaId);
  return (
    <>
      <output aria-label={`Reader target ${paneId}`}>
        {status}:{target?.kind ?? "none"}:{target?.value ?? "none"}
      </output>
      <button type="button" onClick={() => { consumePendingReaderPulse(paneId, mediaId); markActive(); }}>
        Mark reader target active
      </button>
    </>
  );
}

function renderReader(mediaId: string, paneId = `pane-${mediaId}`) {
  return render(
    <ReaderRuntime mediaId={mediaId} paneId={paneId}>
      <ReaderTargetProbe mediaId={mediaId} paneId={paneId} />
    </ReaderRuntime>,
    { reactStrictMode: true },
  );
}

it("retains a pre-mount source through reader replay until the addressed command acknowledges it", async () => {
  const mediaId = "media-target";
  const paneId = "pane-media-target";
  const cache = new ResourceCache({}, READER_CAPACITY.cache);
  const pulse: ReaderPulseTarget = {
    paneId, mediaId, evidenceSpanId: "span-before-mount",
    locator: { type: "web_text_offsets", media_id: mediaId, fragment_id: "fragment-1", start_offset: 4, end_offset: 12,
      text_quote_selector: { exact: "Evidence", prefix: "", suffix: "" } },
    snippet: "Evidence", highlightBehavior: "pulse", focusBehavior: "scroll_into_view",
  };
  const admitted = cache.retainReaderSourceInput(pulse);
  if (admitted.kind !== "Acquired") throw new Error("Source input did not fit its declared profile");
  dispatchReaderPulse(pulse, admitted.lease);
  try {
    const { unmount: unmountUnrelated } = renderReader(mediaId, "other-pane");
    expect(screen.getByLabelText("Reader target other-pane"), "source delivery entered another pane of the same media").toHaveTextContent("idle:none:none");
    unmountUnrelated();

    const { unmount: unmountMatching } = renderReader(mediaId);
    await waitFor(() => expect(screen.getByLabelText(`Reader target ${paneId}`)).toHaveTextContent("pending:source:media-target"));
    unmountMatching();

    const { unmount: unmountReplay } = renderReader(mediaId);
    await waitFor(() => expect(screen.getByLabelText(`Reader target ${paneId}`), "reader replay consumed an unacknowledged source quote").toHaveTextContent("pending:source:media-target"));
    fireEvent.click(screen.getByRole("button", { name: "Mark reader target active" }));
    expect(screen.getByLabelText(`Reader target ${paneId}`)).toHaveTextContent("active:source:media-target");
    unmountReplay();

    renderReader(mediaId);
    expect(screen.getByLabelText(`Reader target ${paneId}`)).toHaveTextContent("idle:none:none");
  } finally { clearPendingReaderPulse(paneId); clearPendingReaderPulse("other-pane"); }
});

it("consumes a hash target after a matching live pulse", async () => {
  const mediaId = "media-hash-target";
  const evidenceSpanId = "span-from-hash";
  function Pane() {
    const [href, setHref] = useState(`/media/${mediaId}#evidence-${evidenceSpanId}`);
    return <><output aria-label="Pane location">{href}</output><ReaderRuntime mediaId={mediaId} href={href}
      onReplacePane={(_paneId, nextHref) => setHref(nextHref)}><ReaderTargetProbe mediaId={mediaId} /></ReaderRuntime></>;
  }
  render(<Pane />);
  await waitFor(() =>
    expect(screen.getByLabelText(`Reader target pane-${mediaId}`)).toHaveTextContent(
      `pending:evidence:${evidenceSpanId}`,
    ),
  );

  await act(async () => {
    const pulse: ReaderPulseTarget = {
      paneId: `pane-${mediaId}`,
      mediaId,
      evidenceSpanId,
      locator: {
        type: "web_text_offsets",
        media_id: mediaId,
        fragment_id: "fragment-1",
        start_offset: 4,
        end_offset: 12,
      },
      snippet: "Evidence",
      highlightBehavior: "pulse",
      focusBehavior: "scroll_into_view",
    };
    const cache = new ResourceCache({}, READER_CAPACITY.cache);
    const admitted = cache.retainReaderSourceInput(pulse);
    if (admitted.kind !== "Acquired") throw new Error("Source input did not fit its declared profile");
    dispatchReaderPulse(pulse, admitted.lease);
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Mark reader target active" }),
  );

  expect(screen.getByLabelText("Pane location")).toHaveTextContent(`/media/${mediaId}`);
  expect(screen.getByLabelText("Pane location").textContent).toBe(`/media/${mediaId}`);
});
