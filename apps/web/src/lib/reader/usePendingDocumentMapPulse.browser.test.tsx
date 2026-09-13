import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { expect, it } from "vitest";
import type { ReaderPulseTarget } from "./pulseEvent";
import { usePendingDocumentMapPulse } from "./usePendingDocumentMapPulse";

function PendingPulseHarness() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const passageRef = useRef<HTMLParagraphElement>(null);
  const actionRef = useRef(0);
  const [revision, setRevision] = useState(0);
  const [pulses, setPulses] = useState<string[]>([]);
  const [arrivals, setArrivals] = useState<string[]>([]);
  const [apparatus, setApparatus] = useState("none");
  const queue = usePendingDocumentMapPulse({
    activeFragmentId: "fragment-target",
    loading: false,
    renderedContentKey: String(revision),
    isTargetVisible: useCallback(() => {
      const viewport = viewportRef.current!.getBoundingClientRect();
      const passage = passageRef.current!.getBoundingClientRect();
      return passage.top >= viewport.top && passage.bottom <= viewport.bottom;
    }, []),
    focusApparatus: useCallback((key, shouldScroll) => {
      if (shouldScroll) throw new Error("Canonical restore alone owns positioning.");
      setApparatus(key);
    }, []),
    dispatchPulse: useCallback((target: ReaderPulseTarget) => {
      setPulses((current) => [...current, target.highlightId!]);
    }, []),
  });
  const activate = (id: string, apparatusStableKey?: string) => {
    const action = ++actionRef.current;
    queue({
      fragmentId: "fragment-target",
      target: {
        mediaId: "media-1", highlightId: id,
        locator: { type: "web_text_offsets", media_id: "media-1", fragment_id: "fragment-target", start_offset: 4, end_offset: 12 },
        snippet: "Evidence", highlightBehavior: "pulse", focusBehavior: "scroll_into_view",
      },
      apparatusStableKey,
      isCurrent: () => action === actionRef.current,
      onArrive: () => setArrivals((current) => [...current, id]),
    });
  };
  return (
    <>
      <button onClick={() => activate("first")}>first destination</button>
      <button onClick={() => activate("second")}>second destination</button>
      <button onClick={() => activate("source", "source-reference")}>source destination</button>
      <button onClick={() => { actionRef.current += 1; queue(null); }}>cancel navigation</button>
      <button onClick={() => {
        passageRef.current!.scrollIntoView({ block: "center" });
        setRevision((value) => value + 1);
      }}>reveal exact source</button>
      <button onClick={() => setRevision((value) => value + 1)}>redecorate</button>
      <div ref={viewportRef} style={{ height: 100, overflow: "auto" }}>
        <div style={{ height: 600 }} />
        <p ref={passageRef} style={{ margin: 0, height: 20 }}>exact source passage</p>
        <div style={{ height: 600 }} />
      </div>
      <output aria-label="pulses">{pulses.join(",") || "none"}</output>
      <output aria-label="arrivals">{arrivals.join(",") || "none"}</output>
      <output aria-label="apparatus">{apparatus}</output>
    </>
  );
}

it("decorates only a visible source owned by the latest navigation, once across rerenders", async () => {
  render(<PendingPulseHarness />);
  fireEvent.click(screen.getByRole("button", { name: "first destination" }));
  fireEvent.click(screen.getByRole("button", { name: "redecorate" }));
  expect(screen.getByLabelText("pulses"), "document map decoration escaped before exact source arrival").toHaveTextContent("none");
  expect(screen.getByLabelText("arrivals")).toHaveTextContent("none");
  fireEvent.click(screen.getByRole("button", { name: "cancel navigation" }));
  fireEvent.click(screen.getByRole("button", { name: "reveal exact source" }));
  expect(screen.getByLabelText("pulses")).toHaveTextContent("none");
  fireEvent.click(screen.getByRole("button", { name: "second destination" }));
  await waitFor(() => expect(screen.getByLabelText("pulses")).toHaveTextContent(/^second$/));
  expect(screen.getByLabelText("arrivals")).toHaveTextContent(/^second$/);
  fireEvent.click(screen.getByRole("button", { name: "redecorate" }));
  expect(screen.getByLabelText("pulses")).toHaveTextContent(/^second$/);
});

it("focuses apparatus only after its exact source is visible without another scroll", async () => {
  render(<PendingPulseHarness />);
  fireEvent.click(screen.getByRole("button", { name: "source destination" }));
  expect(screen.getByLabelText("apparatus")).toHaveTextContent("none");
  fireEvent.click(screen.getByRole("button", { name: "reveal exact source" }));
  await waitFor(() => expect(screen.getByLabelText("apparatus")).toHaveTextContent("source-reference"));
  expect(screen.getByLabelText("arrivals")).toHaveTextContent(/^source$/);
});
