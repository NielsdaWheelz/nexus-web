import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it } from "vitest";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { dispatchReaderPulse } from "@/lib/reader/pulseEvent";
import { useReaderTarget } from "@/lib/reader/useReaderTarget";
import { assumePaneVisitId } from "@/lib/workspace/schema";

const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const noop = () => {};

function ReaderRuntime({
  mediaId,
  children,
}: {
  mediaId: string;
  children: ReactNode;
}) {
  return (
    <PaneRuntimeProvider
      paneId={`pane-${mediaId}`}
      visitId={VISIT_ID}
      isActive
      href={`/media/${mediaId}`}
      routeId="media"
      canGoBack={false}
      canGoForward={false}
      onNavigatePane={noop}
      onReplacePane={noop}
      onActivateWorkspaceTarget={() => ({
        kind: "ActivatedExisting",
        paneId: `pane-${mediaId}`,
      })}
      onGoBackPane={noop}
      onGoForwardPane={noop}
    >
      {children}
    </PaneRuntimeProvider>
  );
}

function ReaderTargetProbe({ mediaId }: { mediaId: string }) {
  const { status, target } = useReaderTarget(mediaId);
  return (
    <output aria-label={`Reader target ${mediaId}`}>
      {status}:{target?.kind ?? "none"}:{target?.value ?? "none"}
    </output>
  );
}

function renderReader(mediaId: string) {
  return render(
    <ReaderRuntime mediaId={mediaId}>
      <ReaderTargetProbe mediaId={mediaId} />
    </ReaderRuntime>,
  );
}

it("keeps a pre-mount pulse with its media and consumes it once", async () => {
  dispatchReaderPulse({
    mediaId: "media-target",
    evidenceSpanId: "span-before-mount",
    locator: {
      type: "web_text_offsets",
      media_id: "media-target",
      fragment_id: "fragment-1",
      start_offset: 4,
      end_offset: 12,
    },
    snippet: "Evidence",
    highlightBehavior: "pulse",
    focusBehavior: "scroll_into_view",
  });

  const { unmount: unmountUnrelated } = renderReader("media-unrelated");
  expect(
    screen.getByLabelText("Reader target media-unrelated"),
  ).toHaveTextContent("idle:none:none");
  unmountUnrelated();

  const { unmount: unmountMatching } = renderReader("media-target");
  await waitFor(() =>
    expect(screen.getByLabelText("Reader target media-target")).toHaveTextContent(
      "pending:evidence:span-before-mount",
    ),
  );
  unmountMatching();

  renderReader("media-target");
  expect(screen.getByLabelText("Reader target media-target")).toHaveTextContent(
    "idle:none:none",
  );
});
