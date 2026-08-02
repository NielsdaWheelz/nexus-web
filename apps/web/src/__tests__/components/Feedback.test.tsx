import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { cdp } from "vitest/browser";
import { Component, type MutableRefObject, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FeedbackNotice,
  FeedbackProvider,
  FieldFeedback,
  useFeedback,
  type DetachedFeedback,
  type FeedbackContextValue,
} from "@/components/feedback/Feedback";

const SPEC = {
  passiveHudMs: 5_000,
  actionableHudMs: 10_000,
  maxHuds: 3,
} as const;

const content = (
  title: string,
  overrides: Partial<DetachedFeedback["content"]> = {},
): DetachedFeedback["content"] => ({
  tone: "Info",
  title,
  ...overrides,
});

function FeedbackHarness({
  apiRef,
}: {
  apiRef: MutableRefObject<FeedbackContextValue | null>;
}) {
  apiRef.current = useFeedback();
  return null;
}

class DiagnosticsDefectBoundary extends Component<
  { children: ReactNode; onDefect: (error: unknown) => void },
  { error: unknown | null }
> {
  state = { error: null as unknown | null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown): void {
    this.props.onDefect(error);
  }

  render() {
    return this.state.error === null ? this.props.children : <div role="alert">Defect</div>;
  }
}

function renderFeedback() {
  const apiRef = { current: null } as MutableRefObject<FeedbackContextValue | null>;
  const view = render(
    <FeedbackProvider>
      <FeedbackHarness apiRef={apiRef} />
    </FeedbackProvider>,
  );
  if (apiRef.current === null) throw new Error("Feedback context was not published.");
  return { ...view, api: apiRef.current };
}

function publish(api: FeedbackContextValue, signal: DetachedFeedback): void {
  act(() => api.publish(signal));
}

// The visual record (detached article or FeedbackNotice) is always an <article>;
// the two detached announcers are role="status"/"alert" live regions, never
// <article>, so scoping to <article> distinguishes the visible record from the
// announcer that may currently hold the same text.
function feedbackArticle(title: string): HTMLElement {
  const matches = screen
    .queryAllByRole("article")
    .filter((candidate) => within(candidate).queryByText(title) !== null);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one feedback article containing ${title}; got ${matches.length}.`,
    );
  }
  return matches[0];
}

function visualTitles(matcher: string | RegExp): HTMLElement[] {
  return ["Persistent feedback", "HUD feedback"].flatMap((label) => {
    const lane = screen.queryByLabelText(label);
    return lane === null ? [] : within(lane).queryAllByText(matcher);
  });
}

function visualTitle(title: string): HTMLElement | null {
  const matches = visualTitles(title);
  if (matches.length > 1) throw new Error(`Multiple visual feedback titles matched ${title}.`);
  return matches[0] ?? null;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Nexus Signal System feedback owner", () => {
  it("mounts fixed-politeness detached announcers and keeps tone independent from urgency", () => {
    const { api } = renderFeedback();
    const polite = screen.getByRole("status");
    const assertive = screen.getByRole("alert");
    const persistentRail = screen.getByLabelText("Persistent feedback");
    const hudViewport = screen.getByLabelText("HUD feedback");

    // Exactly one polite and one assertive announcer are pre-mounted with fixed
    // politeness (never toggled at runtime); the visual lanes own no live role.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(polite).toHaveAttribute("aria-live", "polite");
    expect(assertive).toHaveAttribute("aria-live", "assertive");
    expect(polite).toHaveTextContent("");
    expect(assertive).toHaveTextContent("");
    expect(persistentRail).not.toHaveAttribute("aria-live");
    expect(hudViewport).not.toHaveAttribute("aria-live");

    // A HUD speaks politely regardless of its (Danger) tone.
    publish(api, {
      kind: "Hud",
      key: "danger-hud",
      content: content("Removed", { tone: "Danger" }),
    });

    expect(polite).toHaveTextContent("Removed");
    expect(assertive).toHaveTextContent("");
    expect(feedbackArticle("Removed")).not.toHaveAttribute("role");

    // An assertive persistent record speaks through the fixed assertive region
    // even with a Neutral tone; the polite region clears rather than switching.
    publish(api, {
      kind: "Persistent",
      key: "neutral-persistent",
      content: content("Account needs attention", { tone: "Neutral" }),
      announcement: "Assertive",
    });

    expect(assertive).toHaveTextContent("Account needs attention");
    expect(polite).toHaveTextContent("");
    expect(feedbackArticle("Account needs attention")).not.toHaveAttribute("role");
    expect(polite).toHaveAttribute("aria-live", "polite");
    expect(assertive).toHaveAttribute("aria-live", "assertive");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("maps explicit scoped announcement policy without inferring it from tone", () => {
    const { rerender } = render(
      <FeedbackNotice
        content={content("Quiet failure", { tone: "Danger" })}
        announcement="None"
      />,
    );

    expect(feedbackArticle("Quiet failure")).not.toHaveAttribute("role");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(
      <FeedbackNotice
        content={content("Urgent neutral update", { tone: "Neutral" })}
        announcement="Assertive"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Urgent neutral update");

    rerender(
      <FeedbackNotice
        content={content("Routine progress", { tone: "Warning" })}
        announcement="Polite"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Routine progress");
  });

  it("renders concise anatomy, collapsed copyable diagnostics, ordered actions, and associated field text", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    render(
      <>
        <FeedbackNotice
          content={content("Could not save", {
            tone: "Danger",
            message: "Your changes are still here.",
            requestId: "req-quiet-press",
          })}
          announcement="None"
          actions={[
            { label: "Retry", onClick: first },
            { label: "Open settings", onClick: second },
          ]}
        >
          Recovery uses the same frozen attempt.
        </FeedbackNotice>
        <label htmlFor="title">Title</label>
        <input id="title" aria-describedby="title-feedback" />
        <FieldFeedback
          id="title-feedback"
          content={content("Enter a title", { tone: "Danger" })}
        />
      </>,
    );

    const notice = feedbackArticle("Could not save");
    expect(notice).toHaveTextContent("Danger");
    expect(notice).toHaveTextContent("Your changes are still here.");
    expect(notice).toHaveTextContent("Recovery uses the same frozen attempt.");
    const copyDiagnostics = within(notice).getByRole("button", {
      name: "Copy diagnostics",
    });
    expect(copyDiagnostics).not.toBeVisible();

    fireEvent.click(within(notice).getByText("Diagnostics"));
    expect(copyDiagnostics).toBeVisible();
    fireEvent.click(copyDiagnostics);
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Nexus request ID: req-quiet-press"),
    );

    const actionLabels = within(notice)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(actionLabels).toEqual(["Copy diagnostics", "Retry", "Open settings"]);
    fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
    fireEvent.click(within(notice).getByRole("button", { name: "Open settings" }));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    const field = screen.getByText("Enter a title");
    expect(field).toHaveAttribute("id", "title-feedback");
    expect(field).not.toHaveAttribute("role");
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveAttribute(
      "aria-describedby",
      "title-feedback",
    );
  });

  it("keeps canonical clipboard unavailability near diagnostics with exact Retry", async () => {
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(
        new DOMException("Clipboard permission denied", "NotAllowedError"),
      )
      .mockResolvedValueOnce();
    vi.spyOn(document, "execCommand").mockReturnValue(false);

    render(
      <FeedbackNotice
        content={content("Could not save", { requestId: "req-retry-copy" })}
        announcement="None"
      />,
    );
    const notice = feedbackArticle("Could not save");
    fireEvent.click(within(notice).getByText("Diagnostics"));
    fireEvent.click(within(notice).getByRole("button", { name: "Copy diagnostics" }));

    expect(await within(notice).findByRole("status")).toHaveTextContent(
      "Diagnostics couldn’t be copied.",
    );
    const retry = within(notice).getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    await vi.waitFor(() =>
      expect(within(notice).queryByText("Diagnostics couldn’t be copied.")).toBeNull(),
    );
    expect(within(notice).getByRole("button", { name: "Copy diagnostics" })).toBeVisible();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("lets an atomic scoped notice solely announce its diagnostics copy failure", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new DOMException("Clipboard permission denied", "NotAllowedError"),
    );
    vi.spyOn(document, "execCommand").mockReturnValue(false);

    render(
      <FeedbackNotice
        content={content("Could not save", { requestId: "req-parent-speech" })}
        announcement="Assertive"
      />,
    );
    const notice = screen.getByRole("alert", { name: "" });
    fireEvent.click(within(notice).getByText("Diagnostics"));
    fireEvent.click(within(notice).getByRole("button", { name: "Copy diagnostics" }));

    const copyFailure = await within(notice).findByText("Diagnostics couldn’t be copied.");
    expect(copyFailure).not.toHaveAttribute("role");
    expect(screen.getAllByRole("alert")).toEqual([notice]);
  });

  it("throws an unexpected diagnostics clipboard failure during render", async () => {
    const defect = new Error("Clipboard fallback invariant failed");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new DOMException("Clipboard permission denied", "NotAllowedError"),
    );
    vi.spyOn(document, "execCommand").mockImplementation(() => {
      throw defect;
    });
    const onDefect = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      render(
        <DiagnosticsDefectBoundary onDefect={onDefect}>
          <FeedbackNotice
            content={content("Could not save", { requestId: "req-defect-copy" })}
            announcement="None"
          />
        </DiagnosticsDefectBoundary>,
      );
      fireEvent.click(screen.getByText("Diagnostics"));
      fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));

      await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Defect"));
      expect(onDefect).toHaveBeenCalledWith(defect);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("updates one keyed presentation in place and leaves an identical republish untouched", async () => {
    vi.useFakeTimers();
    const { api } = renderFeedback();
    const initial: DetachedFeedback = {
      kind: "Hud",
      key: "save",
      content: content("Saved"),
    };

    publish(api, initial);
    const article = feedbackArticle("Saved");
    const announcer = screen.getByRole("status");
    const visualMutations = vi.fn();
    const speechMutations = vi.fn();
    const visualObserver = new MutationObserver(visualMutations);
    const speechObserver = new MutationObserver(speechMutations);
    visualObserver.observe(article, { attributes: true, childList: true, subtree: true });
    speechObserver.observe(announcer, { attributes: true, childList: true, subtree: true });

    publish(api, initial);
    await Promise.resolve();
    expect(visualMutations).not.toHaveBeenCalled();
    expect(speechMutations).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(4_000));
    publish(api, {
      kind: "Hud",
      key: "save",
      content: content("Saved to Library", { tone: "Success" }),
    });

    expect(feedbackArticle("Saved to Library")).toBe(article);
    expect(announcer).toHaveTextContent("Saved to Library");
    act(() => vi.advanceTimersByTime(SPEC.passiveHudMs - 1));
    expect(visualTitle("Saved to Library")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(visualTitle("Saved to Library")).not.toBeInTheDocument();

    visualObserver.disconnect();
    speechObserver.disconnect();
  });

  it("expires passive and actionable HUDs at their fixed durations and caps only the HUD lane", () => {
    vi.useFakeTimers();
    const { api } = renderFeedback();

    publish(api, { kind: "Hud", key: "passive", content: content("Passive") });
    act(() => vi.advanceTimersByTime(SPEC.passiveHudMs - 1));
    expect(visualTitle("Passive")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(visualTitle("Passive")).not.toBeInTheDocument();

    publish(api, {
      kind: "Hud",
      key: "actionable",
      content: content("Actionable"),
      actions: [{ label: "Undo", onClick: () => {} }],
    });
    act(() => vi.advanceTimersByTime(SPEC.actionableHudMs - 1));
    expect(visualTitle("Actionable")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(visualTitle("Actionable")).not.toBeInTheDocument();

    for (let index = 1; index <= SPEC.maxHuds + 1; index += 1) {
      publish(api, { kind: "Hud", key: `hud-${index}`, content: content(`HUD ${index}`) });
    }
    expect(visualTitle("HUD 1")).not.toBeInTheDocument();
    expect(visualTitles(/^HUD \d$/)).toHaveLength(SPEC.maxHuds);
  });

  it("exempts a hovered HUD from eviction and drops the oldest non-paused HUD", () => {
    vi.useFakeTimers();
    const { api } = renderFeedback();

    for (let index = 1; index <= SPEC.maxHuds; index += 1) {
      publish(api, { kind: "Hud", key: `hud-${index}`, content: content(`HUD ${index}`) });
    }
    // The user hovers the oldest HUD to read it: its timer pauses (WCAG 2.2.1),
    // so a HUD arriving over the cap must evict the oldest NON-paused HUD
    // instead of yanking the one being read.
    fireEvent.mouseEnter(feedbackArticle("HUD 1"));
    publish(api, { kind: "Hud", key: "hud-4", content: content("HUD 4") });

    expect(visualTitle("HUD 1")).toBeInTheDocument();
    expect(visualTitle("HUD 2")).not.toBeInTheDocument();
    expect(visualTitle("HUD 3")).toBeInTheDocument();
    expect(visualTitle("HUD 4")).toBeInTheDocument();
  });

  it("keeps the persistent rail uncapped and unresolved until its owner resolves it", () => {
    vi.useFakeTimers();
    const { api } = renderFeedback();

    for (let index = 1; index <= 5; index += 1) {
      publish(api, {
        kind: "Persistent",
        key: `persistent-${index}`,
        content: content(`Persistent ${index}`, { tone: "Warning" }),
        announcement: "Polite",
      });
    }
    const firstArticle = feedbackArticle("Persistent 1");
    act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1_000));
    expect(visualTitles(/^Persistent \d$/)).toHaveLength(5);

    publish(api, {
      kind: "Persistent",
      key: "persistent-1",
      content: content("Persistent recovered", { tone: "Success" }),
      announcement: "Polite",
    });
    expect(feedbackArticle("Persistent recovered")).toBe(firstArticle);

    act(() => api.resolve("persistent-1"));
    expect(visualTitle("Persistent recovered")).not.toBeInTheDocument();
    expect(visualTitles(/^Persistent \d$/)).toHaveLength(4);
  });

  it("composes suppression leases and announces restoration only when hidden content changed", async () => {
    const { api } = renderFeedback();
    const announcer = screen.getByRole("alert");
    const releaseFirst = api.suppress("profile-save");
    const releaseSecond = api.suppress("profile-save");

    publish(api, {
      kind: "Persistent",
      key: "profile-save",
      content: content("Save failed", { tone: "Danger" }),
      announcement: "Assertive",
    });
    expect(visualTitle("Save failed")).not.toBeInTheDocument();
    expect(announcer).toHaveTextContent("");

    act(() => releaseFirst());
    expect(visualTitle("Save failed")).not.toBeInTheDocument();

    publish(api, {
      kind: "Persistent",
      key: "profile-save",
      content: content("Save still failing", { tone: "Danger" }),
      announcement: "Assertive",
    });
    act(() => releaseSecond());
    expect(visualTitle("Save still failing")).toBeInTheDocument();
    expect(announcer).toHaveTextContent("Save still failing");

    const speechMutations = vi.fn();
    const observer = new MutationObserver(speechMutations);
    observer.observe(announcer, { attributes: true, childList: true, subtree: true });
    const releaseUnchanged = api.suppress("profile-save");
    act(() => releaseUnchanged());
    await Promise.resolve();
    expect(visualTitle("Save still failing")).toBeInTheDocument();
    expect(speechMutations).not.toHaveBeenCalled();
    observer.disconnect();
  });

  it("pauses HUD remaining time while hidden, hovered, or keyboard-focused", () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const { api } = renderFeedback();

    publish(api, { kind: "Hud", key: "hidden", content: content("Hidden pause") });
    act(() => vi.advanceTimersByTime(4_000));
    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(60_000));
    expect(visualTitle("Hidden pause")).toBeInTheDocument();
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(999));
    expect(visualTitle("Hidden pause")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(visualTitle("Hidden pause")).not.toBeInTheDocument();

    publish(api, { kind: "Hud", key: "hover", content: content("Hover pause") });
    act(() => vi.advanceTimersByTime(4_000));
    const hoverArticle = feedbackArticle("Hover pause");
    fireEvent.mouseEnter(hoverArticle);
    act(() => vi.advanceTimersByTime(60_000));
    expect(visualTitle("Hover pause")).toBeInTheDocument();
    fireEvent.mouseLeave(hoverArticle);
    act(() => vi.advanceTimersByTime(1_000));
    expect(visualTitle("Hover pause")).not.toBeInTheDocument();

    publish(api, {
      kind: "Hud",
      key: "focus",
      content: content("Focus pause"),
      actions: [{ label: "Undo focus", onClick: () => {} }],
    });
    act(() => vi.advanceTimersByTime(9_000));
    const action = screen.getByRole("button", { name: "Undo focus" });
    act(() => action.focus());
    act(() => vi.advanceTimersByTime(60_000));
    expect(visualTitle("Focus pause")).toBeInTheDocument();
    act(() => action.blur());
    act(() => vi.advanceTimersByTime(1_000));
    expect(visualTitle("Focus pause")).not.toBeInTheDocument();
  });

  it("pauses a suppressed HUD and restores its remaining time without replaying speech", async () => {
    vi.useFakeTimers();
    const { api } = renderFeedback();
    publish(api, { kind: "Hud", key: "local-owner", content: content("Background saved") });
    const announcer = screen.getByRole("status");
    const speechMutations = vi.fn();
    const observer = new MutationObserver(speechMutations);
    observer.observe(announcer, { attributes: true, childList: true, subtree: true });

    act(() => vi.advanceTimersByTime(4_000));
    let release: () => void = () => {};
    act(() => {
      release = api.suppress("local-owner");
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(visualTitle("Background saved")).not.toBeInTheDocument();
    act(() => release());
    await Promise.resolve();
    expect(visualTitle("Background saved")).toBeInTheDocument();
    expect(speechMutations).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(visualTitle("Background saved")).not.toBeInTheDocument();
    observer.disconnect();

    publish(api, {
      kind: "Hud",
      key: "paused-local-owner",
      content: content("Paused owner saved"),
    });
    act(() => vi.advanceTimersByTime(4_000));
    fireEvent.mouseEnter(feedbackArticle("Paused owner saved"));
    let releasePaused: () => void = () => {};
    act(() => {
      releasePaused = api.suppress("paused-local-owner");
    });
    expect(visualTitle("Paused owner saved")).not.toBeInTheDocument();
    act(() => releasePaused());
    act(() => vi.advanceTimersByTime(1_000));
    expect(visualTitle("Paused owner saved")).not.toBeInTheDocument();
  });

  it("keeps a suppressed HUD outside the visual cap and evicts the oldest other HUD on release", () => {
    vi.useFakeTimers();
    const { api } = renderFeedback();

    publish(api, {
      kind: "Hud",
      key: "suppressed-owner",
      content: content("Suppressed owner"),
    });
    act(() => vi.advanceTimersByTime(4_000));
    let release: () => void = () => {};
    act(() => {
      release = api.suppress("suppressed-owner");
    });

    for (let index = 1; index <= SPEC.maxHuds; index += 1) {
      publish(api, {
        kind: "Hud",
        key: `visible-${index}`,
        content: content(`Visible ${index}`),
      });
    }
    expect(visualTitle("Suppressed owner")).not.toBeInTheDocument();
    expect(visualTitles(/^Visible \d$/)).toHaveLength(SPEC.maxHuds);

    act(() => release());
    expect(visualTitle("Suppressed owner")).toBeInTheDocument();
    expect(visualTitle("Visible 1")).not.toBeInTheDocument();
    expect(visualTitle("Visible 2")).toBeInTheDocument();
    expect(visualTitle("Visible 3")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(999));
    expect(visualTitle("Suppressed owner")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(visualTitle("Suppressed owner")).not.toBeInTheDocument();
  });

  it("removes travel and pulse choreography when reduced motion is requested", async () => {
    const session = cdp() as unknown as {
      send(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      const { api } = renderFeedback();
      publish(api, { kind: "Hud", key: "motion", content: content("Motion quiet") });
      const article = feedbackArticle("Motion quiet");
      expect(getComputedStyle(article).animationName).toBe("none");
      expect(getComputedStyle(article).transitionDuration).toBe("0s");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
    }
  });
});
