import { useRef, useState } from "react";
import { useReaderProgress, type ReaderCapability } from "./useReaderProgress";
import type { HostedReaderProgressPort } from "./hostedReaderProgress";
import type { ReaderCursorSnapshot } from "./readerProgress";
import type { ReaderResumeState } from "./types";

export function ReaderProgressHarness({ port, capability, movement, reset, commitReset }: {
  port: HostedReaderProgressPort;
  capability: ReaderCapability;
  movement: ReaderResumeState;
  reset?: ReaderCursorSnapshot;
  commitReset?: () => void;
}) {
  const current = useRef(movement);
  const [defect, setDefect] = useState<unknown>(null);
  const [installed, setInstalled] = useState(false);
  const progress = useReaderProgress({
    capability, port, isPaneActive: true,
    handleUnauthenticatedError: () => false,
    reportDefect: setDefect,
    captureCurrentLocator: () => current.current,
    applyCursor: async () => "applied",
    onTerminalWriteAcknowledged: () => {},
    previewLease: { isActive: () => false },
  });
  return <>
    <output aria-label="Progress authority">{progress.status}</output>
    <output aria-label="Source status">{progress.sourceStatus}</output>
    <output aria-label="Progress defect">{defect instanceof Error ? defect.message : "none"}</output>
    <output aria-label="Reset installed">{String(installed)}</output>
    <button onClick={() => progress.reportMovement(movement)}>Move reader</button>
    <button onClick={progress.retryLoad}>Retry authority</button>
    {reset !== undefined && <button onClick={() => {
      commitReset?.();
      void progress.installCanonicalSnapshot(reset).then(() => setInstalled(true));
    }}>Install committed reset</button>}
  </>;
}
