import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { expect, it } from "vitest";
import type { ReaderPulseTarget } from "./pulseEvent";
import { usePendingDocumentMapPulse } from "./usePendingDocumentMapPulse";

function pulseTarget(highlightId: string): ReaderPulseTarget {
  return {
    mediaId: "media-1",
    highlightId,
    locator: {
      type: "web_text_offsets",
      media_id: "media-1",
      fragment_id: "fragment-target",
      start_offset: 4,
      end_offset: 12,
    },
    snippet: "Evidence",
    highlightBehavior: "pulse",
    focusBehavior: "scroll_into_view",
  };
}

function pulseTelemetry(): string {
  return screen.getByLabelText("Pending pulse telemetry").textContent ?? "";
}

function PendingPulseHarness() {
  const [activeFragmentId, setActiveFragmentId] = useState("fragment-origin");
  const [renderRevision, setRenderRevision] = useState(0);
  const outputRef = useRef<HTMLOutputElement>(null);
  const attemptsRef = useRef(0);
  const cancellationsRef = useRef(0);
  const completionsRef = useRef<Array<() => void>>([]);
  const pulsesRef = useRef<string[]>([]);
  const apparatusRef = useRef<string[]>([]);

  const publish = useCallback(() => {
    if (!outputRef.current) return;
    outputRef.current.textContent = [
      `attempts=${attemptsRef.current}`,
      `cancellations=${cancellationsRef.current}`,
      `pulses=${pulsesRef.current.join(",") || "none"}`,
      `apparatus=${apparatusRef.current.join(",") || "none"}`,
    ].join(";");
  }, []);

  const scrollHighlight = useCallback(
    (highlightId: string, afterPosition: () => void) => {
      attemptsRef.current += 1;
      completionsRef.current.push(afterPosition);
      publish();
      return () => {
        cancellationsRef.current += 1;
        publish();
      };
    },
    [publish],
  );
  const dispatchPulse = useCallback(
    (target: ReaderPulseTarget) => {
      pulsesRef.current.push(target.highlightId ?? "missing-highlight");
      publish();
    },
    [publish],
  );
  const focusApparatus = useCallback(
    (stableKey: string) => {
      apparatusRef.current.push(stableKey);
      publish();
    },
    [publish],
  );
  const queue = usePendingDocumentMapPulse({
    activeFragmentId,
    loading: false,
    renderedContentKey: String(renderRevision),
    focusApparatus,
    scrollHighlight,
    dispatchPulse,
  });

  const activate = (highlightId: string) => {
    queue({
      fragmentId: "fragment-target",
      target: pulseTarget(highlightId),
    });
    setActiveFragmentId("fragment-target");
    setRenderRevision((revision) => revision + 1);
  };

  const activateApparatus = () => {
    queue({
      fragmentId: "fragment-target",
      target: pulseTarget("apparatus-highlight"),
      apparatusStableKey: "source-reference-1",
    });
    setActiveFragmentId("fragment-target");
    setRenderRevision((revision) => revision + 1);
  };

  return (
    <>
      <button type="button" onClick={() => activate("highlight-1")}>
        Activate first highlight
      </button>
      <button type="button" onClick={() => activate("highlight-2")}>
        Replace with second highlight
      </button>
      <button type="button" onClick={activateApparatus}>
        Activate source reference
      </button>
      <button
        type="button"
        onClick={() => setRenderRevision((revision) => revision + 1)}
      >
        Interrupt rendered content
      </button>
      <button type="button" onClick={() => completionsRef.current[0]?.()}>
        Complete first attempt
      </button>
      <button
        type="button"
        onClick={() => completionsRef.current.at(-1)?.()}
      >
        Complete latest attempt
      </button>
      <output ref={outputRef} aria-label="Pending pulse telemetry">
        attempts=0;cancellations=0;pulses=none;apparatus=none
      </output>
    </>
  );
}

it("retries a cancelled highlight position before releasing its pending pulse", async () => {
  render(<PendingPulseHarness />);

  fireEvent.click(screen.getByRole("button", { name: "Activate first highlight" }));
  await waitFor(() =>
    expect(pulseTelemetry()).toBe(
      "attempts=1;cancellations=0;pulses=none;apparatus=none",
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Interrupt rendered content" }));
  await waitFor(() =>
    expect(
      pulseTelemetry(),
      "Interrupted render did not retain the pending Document Map highlight",
    ).toBe("attempts=2;cancellations=1;pulses=none;apparatus=none"),
  );

  fireEvent.click(screen.getByRole("button", { name: "Complete latest attempt" }));
  expect(
    pulseTelemetry(),
    "A render interruption discarded the pending Document Map highlight activation",
  ).toBe("attempts=2;cancellations=1;pulses=highlight-1;apparatus=none");

  fireEvent.click(screen.getByRole("button", { name: "Interrupt rendered content" }));
  await waitFor(() =>
    expect(pulseTelemetry()).toBe(
      "attempts=2;cancellations=2;pulses=highlight-1;apparatus=none",
    ),
  );
});

it("ignores a cancelled completion after a newer highlight takes ownership", async () => {
  render(<PendingPulseHarness />);

  fireEvent.click(screen.getByRole("button", { name: "Activate first highlight" }));
  await waitFor(() =>
    expect(pulseTelemetry()).toBe(
      "attempts=1;cancellations=0;pulses=none;apparatus=none",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Replace with second highlight" }));
  await waitFor(() =>
    expect(pulseTelemetry()).toBe(
      "attempts=2;cancellations=1;pulses=none;apparatus=none",
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Complete first attempt" }));
  expect(
    pulseTelemetry(),
    "A cancelled activation was allowed to pulse after a newer target took ownership",
  ).toBe("attempts=2;cancellations=1;pulses=none;apparatus=none");

  fireEvent.click(screen.getByRole("button", { name: "Complete latest attempt" }));
  expect(pulseTelemetry()).toBe(
    "attempts=2;cancellations=1;pulses=highlight-2;apparatus=none",
  );
});

it("focuses and pulses a queued source reference after its fragment commits", async () => {
  render(<PendingPulseHarness />);

  fireEvent.click(screen.getByRole("button", { name: "Activate source reference" }));

  await waitFor(() =>
    expect(
      pulseTelemetry(),
      "Queued source-reference activation did not complete both visible effects",
    ).toBe(
      "attempts=0;cancellations=0;pulses=apparatus-highlight;apparatus=source-reference-1",
    ),
  );
});
