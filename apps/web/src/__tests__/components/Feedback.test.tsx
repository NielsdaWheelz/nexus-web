import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FeedbackNotice,
  FeedbackProvider,
  toFeedback,
  useFeedback,
} from "@/components/feedback/Feedback";
import { ApiError } from "@/lib/api/client";

function ToastHarness() {
  const feedback = useFeedback();
  const releases = useRef<Array<() => void>>([]);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          feedback.show({
            severity: "success",
            title: "Saved",
            dedupeKey: "save",
            duration: 100,
          })
        }
      >
        Show saved
      </button>
      <button
        type="button"
        onClick={() =>
          feedback.show({
            severity: "success",
            title: "Saved again",
            dedupeKey: "save",
            duration: 0,
          })
        }
      >
        Show saved again
      </button>
      <button
        type="button"
        onClick={() =>
          feedback.show({
            severity: "info",
            title: "Other notice",
            dedupeKey: "other",
            duration: 0,
          })
        }
      >
        Show other
      </button>
      <button
        type="button"
        onClick={() =>
          feedback.show({
            severity: "error",
            title: "Save failed",
            dedupeKey: "save",
            duration: 0,
            action: { label: "Retry", onClick: () => {} },
          })
        }
      >
        Show failed with retry
      </button>
      <button
        type="button"
        onClick={() =>
          feedback.show({
            severity: "error",
            title: "Save forbidden",
            dedupeKey: "save",
            duration: 0,
          })
        }
      >
        Show failed without retry
      </button>
      <button
        type="button"
        onClick={() =>
          feedback.show({
            severity: "success",
            title: "Linked to Some Media",
            dedupeKey: "link",
            action: [
              { label: "Undo", onClick: () => {} },
              { label: "Add note to link", onClick: () => {} },
            ],
          })
        }
      >
        Show linked with two actions
      </button>
      <button type="button" onClick={() => feedback.dismissByDedupeKey("save")}>
        Dismiss save
      </button>
      <button type="button" onClick={() => feedback.dismissByDedupeKey("unknown-key")}>
        Dismiss unknown
      </button>
      <button
        type="button"
        onClick={() => {
          releases.current.push(feedback.suppressDedupeKey("save"));
        }}
      >
        Suppress save
      </button>
      <button type="button" onClick={() => releases.current[0]?.()}>
        Release lease 0
      </button>
      <button type="button" onClick={() => releases.current[1]?.()}>
        Release lease 1
      </button>
    </>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("feedback layer", () => {
  it("converts API errors through owned copy and keeps the request id", () => {
    expect(
      toFeedback(new ApiError(500, "E_INTERNAL", "Internal database detail", "req-1"), {
        fallback: "Unable to save.",
      })
    ).toEqual({
      severity: "error",
      title: "Unable to save.",
      requestId: "req-1",
    });

    expect(
      toFeedback(new ApiError(400, "E_KEY_TEST_FAILED", "Provider test failed", "req-2"), {
        fallback: "Unable to test the API key.",
      })
    ).toEqual({
      severity: "error",
      title: "Provider test failed",
      requestId: "req-2",
    });
  });

  it("maps the author-dedup error codes to their frozen DP-1 titles", () => {
    expect(
      toFeedback(new ApiError(422, "E_AUTHOR_ALREADY_LISTED", "duplicate", "req-a"), {
        fallback: "Couldn't save your changes.",
      }),
    ).toEqual({
      severity: "error",
      title: "That author is already listed for this role.",
      requestId: "req-a",
    });

    expect(
      toFeedback(new ApiError(409, "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH", "replay", "req-b"), {
        fallback: "Couldn't save your changes.",
      }),
    ).toEqual({
      severity: "error",
      title: "That author change changed. Reload and try again.",
      requestId: "req-b",
    });
  });

  it("renders inline errors as alerts with support metadata", () => {
    render(
      <FeedbackNotice
        feedback={{
          severity: "error",
          title: "Unable to load library.",
          requestId: "req-3",
        }}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load library.");
    expect(screen.getByRole("alert")).toHaveTextContent("Nexus request ID: req-3");
  });

  it("dedupes, dismisses, and auto-dismisses toasts", () => {
    vi.useFakeTimers();
    render(
      <FeedbackProvider>
        <ToastHarness />
      </FeedbackProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");

    fireEvent.click(screen.getByRole("button", { name: "Show saved again" }));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Saved again");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Saved again" }));
    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByText("Saved again")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    act(() => vi.advanceTimersByTime(250));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("dismissByDedupeKey removes an owned toast permanently and no-ops for an unknown key", () => {
    vi.useFakeTimers();
    render(
      <FeedbackProvider>
        <ToastHarness />
      </FeedbackProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    expect(screen.getByText("Saved")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss unknown" }));
    expect(screen.getByText("Saved")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss save" }));
    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("suppressDedupeKey hides a toast without touching a different dedupeKey, and reveals it on show()", () => {
    vi.useFakeTimers();
    render(
      <FeedbackProvider>
        <ToastHarness />
      </FeedbackProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    fireEvent.click(screen.getByRole("button", { name: "Show other" }));
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("Other notice")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Suppress save" }));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.getByText("Other notice")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Release lease 0" }));
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("hides a show() made while its dedupeKey is already suppressed, until release", () => {
    vi.useFakeTimers();
    render(
      <FeedbackProvider>
        <ToastHarness />
      </FeedbackProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Suppress save" }));
    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Release lease 0" }));
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("composes suppression leases by count: releasing one keeps it hidden, releasing the second reveals it", () => {
    vi.useFakeTimers();
    render(
      <FeedbackProvider>
        <ToastHarness />
      </FeedbackProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    fireEvent.click(screen.getByRole("button", { name: "Suppress save" }));
    fireEvent.click(screen.getByRole("button", { name: "Suppress save" }));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Release lease 0" }));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Release lease 1" }));
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("does not corrupt the lease count when the same release function is called twice", () => {
    vi.useFakeTimers();
    render(
      <FeedbackProvider>
        <ToastHarness />
      </FeedbackProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    fireEvent.click(screen.getByRole("button", { name: "Suppress save" }));
    fireEvent.click(screen.getByRole("button", { name: "Suppress save" }));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Release lease 0" }));
    fireEvent.click(screen.getByRole("button", { name: "Release lease 0" }));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Release lease 1" }));
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("dismissByDedupeKey while suppressed removes the record so release reveals nothing", () => {
    vi.useFakeTimers();
    render(
      <FeedbackProvider>
        <ToastHarness />
      </FeedbackProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    fireEvent.click(screen.getByRole("button", { name: "Suppress save" }));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss save" }));
    act(() => vi.advanceTimersByTime(150));

    fireEvent.click(screen.getByRole("button", { name: "Release lease 0" }));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("does not silently auto-dismiss a suppressed toast while its duration elapses", () => {
    vi.useFakeTimers();
    render(
      <FeedbackProvider>
        <ToastHarness />
      </FeedbackProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    fireEvent.click(screen.getByRole("button", { name: "Suppress save" }));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(500));

    fireEvent.click(screen.getByRole("button", { name: "Release lease 0" }));
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("revives a toast re-shown within the exit window instead of letting the stale removal delete it", () => {
    vi.useFakeTimers();
    render(
      <FeedbackProvider>
        <ToastHarness />
      </FeedbackProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Show failed with retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss save" }));
    // Re-shown mid-exit (before the 150ms removal): the record is revived.
    act(() => vi.advanceTimersByTime(100));
    fireEvent.click(screen.getByRole("button", { name: "Show failed with retry" }));

    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText("Save failed")).toBeInTheDocument();
  });

  it("drops a stale action when a re-show of the same dedupeKey omits it", () => {
    vi.useFakeTimers();
    render(
      <FeedbackProvider>
        <ToastHarness />
      </FeedbackProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Show failed with retry" }));
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    // Forbidden replacing SaveFailed must not retain the Retry action.
    fireEvent.click(screen.getByRole("button", { name: "Show failed without retry" }));
    expect(screen.getByText("Save forbidden")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("renders two ordered actions for an actionable toast and never auto-dismisses it", () => {
    vi.useFakeTimers();
    render(
      <FeedbackProvider>
        <ToastHarness />
      </FeedbackProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Show linked with two actions" }));
    expect(screen.getByText("Linked to Some Media")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add note to link" })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Linked to Some Media")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByText("Linked to Some Media")).not.toBeInTheDocument();
  });
});
