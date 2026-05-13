import { act, fireEvent, render, screen } from "@testing-library/react";
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
});
