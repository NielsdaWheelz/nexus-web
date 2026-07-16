import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import ReaderProgressHandoff from "./ReaderProgressHandoff";
import type { ReaderProgressHandoffState } from "@/lib/reader/useReaderProgress";
import type { ReaderCursorPositioned } from "@/lib/reader/readerProgress";

const SNAPSHOT: ReaderCursorPositioned = {
  state: "Positioned",
  revision: 2,
  locator: {
    kind: "web",
    target: { fragment_id: "frag-1" },
    locations: {
      text_offset: 10,
      progression: null,
      total_progression: 0.5,
      position: 1,
    },
    text: { quote: null, quote_prefix: null, quote_suffix: null },
  },
};

function baseHandoff(overrides: Partial<ReaderProgressHandoffState> = {}): ReaderProgressHandoffState {
  return {
    snapshot: SNAPSHOT,
    busy: false,
    applyFailed: false,
    captureUnavailable: false,
    ...overrides,
  };
}

type Props = Parameters<typeof ReaderProgressHandoff>[0];

function renderHandoff(overrides: Partial<Props> = {}) {
  const onAccept = vi.fn();
  const onStay = vi.fn();
  const onRetrySave = vi.fn();
  const focusReaderViewport = vi.fn();
  const props: Props = {
    handoff: null,
    announcement: "",
    saveFailed: false,
    onAccept,
    onStay,
    onRetrySave,
    focusReaderViewport,
    ...overrides,
  };
  const utils = render(<ReaderProgressHandoff {...props} />);
  return { ...utils, onAccept, onStay, onRetrySave, focusReaderViewport, props };
}

function liveRegionOf(container: HTMLElement): HTMLElement {
  // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the live region is a plain div with no implicit ARIA role to query by; aria-live is the only contract it carries
  const el = container.querySelector('[aria-live="polite"]');
  if (!el) {
    throw new Error("Expected a polite live region to be rendered");
  }
  return el as HTMLElement;
}

describe("ReaderProgressHandoff", () => {
  it("renders nothing actionable when handoff is null and saveFailed is false", () => {
    const { container } = renderHandoff({ handoff: null, saveFailed: false, announcement: "" });

    expect(liveRegionOf(container)).toHaveTextContent("");
    expect(
      screen.queryByRole("group", { name: "More recent reading position available" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Progress not synced")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("puts the handoff message in the polite live region, with the action buttons outside it", () => {
    const { container } = renderHandoff({ handoff: baseHandoff() });

    const liveRegion = liveRegionOf(container);
    expect(liveRegion).toHaveTextContent("More recent reading position available");

    const acceptButton = screen.getByRole("button", { name: "Go to most recent position" });
    const stayButton = screen.getByRole("button", { name: "Stay at this position" });
    expect(liveRegion).not.toContainElement(acceptButton);
    expect(liveRegion).not.toContainElement(stayButton);
  });

  it("calls onAccept and onStay from their respective buttons", async () => {
    const user = userEvent.setup();
    const { onAccept, onStay } = renderHandoff({ handoff: baseHandoff() });

    await user.click(screen.getByRole("button", { name: "Go to most recent position" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onStay).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Stay at this position" }));
    expect(onStay).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons while busy", () => {
    renderHandoff({ handoff: baseHandoff({ busy: true }) });

    expect(screen.getByRole("button", { name: "Go to most recent position" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stay at this position" })).toBeDisabled();
  });

  it("shows the apply-failed retry hint", () => {
    renderHandoff({ handoff: baseHandoff({ applyFailed: true }) });

    expect(screen.getByText("Couldn't go to that position. Retry.")).toBeInTheDocument();
  });

  it("shows the capture-unavailable retry hint", () => {
    renderHandoff({ handoff: baseHandoff({ captureUnavailable: true }) });

    expect(screen.getByText("Couldn't read this position. Retry.")).toBeInTheDocument();
  });

  it("returns focus to the reader viewport when the handoff resolves via a button click", async () => {
    const user = userEvent.setup();
    const { rerender, onAccept, focusReaderViewport, props } = renderHandoff({
      handoff: baseHandoff(),
    });

    await user.click(screen.getByRole("button", { name: "Go to most recent position" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(focusReaderViewport).not.toHaveBeenCalled();

    rerender(<ReaderProgressHandoff {...props} handoff={null} />);

    expect(focusReaderViewport).toHaveBeenCalledTimes(1);
  });

  it("does not steal focus when the handoff disappears without a button interaction", () => {
    const { rerender, focusReaderViewport, props } = renderHandoff({ handoff: baseHandoff() });

    rerender(<ReaderProgressHandoff {...props} handoff={null} />);

    expect(focusReaderViewport).not.toHaveBeenCalled();
  });

  it("renders the sync-error surface with a working retry button when saveFailed is true", async () => {
    const user = userEvent.setup();
    const { onRetrySave } = renderHandoff({ saveFailed: true });

    expect(screen.getByText("Progress not synced")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "Retry" });

    await user.click(retryButton);
    expect(onRetrySave).toHaveBeenCalledTimes(1);
  });
});
