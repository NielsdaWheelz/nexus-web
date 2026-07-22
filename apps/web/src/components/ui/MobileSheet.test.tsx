import { useRef, useState, type ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import MobileSheet from "@/components/ui/MobileSheet";

const noop = () => {};

function sheet(props: Partial<ComponentProps<typeof MobileSheet>> = {}) {
  return withRenderEnvironment(
    <MobileSheet active onDismiss={noop} ariaLabel="Test sheet" {...props}>
      <button type="button">First</button>
      <button type="button">Last</button>
    </MobileSheet>,
    { initialViewport: "mobile" },
  );
}

const dialog = () => screen.getByRole("dialog", { name: "Test sheet" });
const first = () => screen.getByRole("button", { name: "First" });
const last = () => screen.getByRole("button", { name: "Last" });
// eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the grabber is aria-hidden decorative; no role/label to query by
const grabber = () => document.querySelector("[data-grabber]");

/** EventTarget-based visualViewport stub (the keyboard-inset hook test's pattern). */
function installFakeViewport(height: number) {
  const vv = new EventTarget() as EventTarget & { height: number; offsetTop: number };
  vv.height = height;
  vv.offsetTop = 0;
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return vv;
}

function resizeViewport(vv: ReturnType<typeof installFakeViewport>, height: number) {
  act(() => {
    vv.height = height;
    vv.dispatchEvent(new Event("resize"));
  });
}

// The synthetic-entry pop is deferred to a microtask (useHistoryDismiss); flush it.
const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

function NestedSheets({
  onOuterDismiss,
  onInnerDismiss,
}: {
  onOuterDismiss: () => void;
  onInnerDismiss: () => void;
}) {
  const [outerActive, setOuterActive] = useState(true);
  const [innerActive, setInnerActive] = useState(false);
  const innerTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <MobileSheet
        active={outerActive}
        onDismiss={() => {
          onOuterDismiss();
          setOuterActive(false);
        }}
        ariaLabel="Outer sheet"
        backdropTestId="outer-backdrop"
        panelTestId="outer-sheet"
      >
        <button
          ref={innerTriggerRef}
          type="button"
          onClick={() => setInnerActive(true)}
        >
          Open inner sheet
        </button>
      </MobileSheet>
      <MobileSheet
        active={innerActive}
        onDismiss={() => {
          onInnerDismiss();
          setInnerActive(false);
        }}
        ariaLabel="Inner sheet"
        returnFocusTo={() => innerTriggerRef.current}
        backdropTestId="inner-backdrop"
        panelTestId="inner-sheet"
      >
        <button type="button">Inner action</button>
      </MobileSheet>
    </>
  );
}

describe("MobileSheet", () => {
  // history.* are browser globals (not internal modules). Model history.state
  // locally so the marker bookkeeping is observable without mutating the real
  // stack; `back` clears the marker the way a real pop would.
  let fakeState: unknown = null;

  beforeEach(() => {
    fakeState = null;
    vi.spyOn(history, "pushState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "replaceState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "back").mockImplementation(() => {
      fakeState = null;
    });
    vi.spyOn(history, "state", "get").mockImplementation(() => fakeState);
    // setPointerCapture isn't implemented for synthetic pointer events in the test env.
    vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.style.overflow = "";
    Reflect.deleteProperty(window, "visualViewport");
    document.documentElement.style.removeProperty("--space-6");
  });

  it("renders a modal dialog with the aria label and grabber while active", () => {
    render(sheet({ panelId: "pane-1-reader-tools" }));
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(dialog()).toHaveAttribute("id", "pane-1-reader-tools");
    expect(grabber()).not.toBeNull();
    expect(first()).toBeVisible();
  });

  it("renders nothing while inactive", () => {
    render(sheet({ active: false }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("gives nested sheets exclusive modality, Escape, and return focus", async () => {
    const onOuterDismiss = vi.fn();
    const onInnerDismiss = vi.fn();
    render(
      withRenderEnvironment(
        <NestedSheets
          onOuterDismiss={onOuterDismiss}
          onInnerDismiss={onInnerDismiss}
        />,
        { initialViewport: "mobile" },
      ),
    );

    const innerTrigger = screen.getByRole("button", {
      name: "Open inner sheet",
    });
    await waitFor(() => expect(innerTrigger).toHaveFocus());
    fireEvent.click(innerTrigger);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Inner action" })).toHaveFocus(),
    );

    expect(screen.getByTestId("inner-sheet")).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(screen.getByTestId("outer-sheet")).not.toHaveAttribute("aria-modal");
    expect(screen.getByTestId("outer-sheet")).toHaveAttribute("inert");
    expect(screen.getByTestId("outer-backdrop")).toHaveAttribute(
      "data-suspended",
      "true",
    );
    expect(getComputedStyle(screen.getByTestId("outer-backdrop")).backgroundColor)
      .toBe("rgba(0, 0, 0, 0)");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onInnerDismiss).toHaveBeenCalledOnce();
    expect(onOuterDismiss).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId("inner-sheet")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("outer-sheet")).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(screen.getByTestId("outer-sheet")).not.toHaveAttribute("inert");
    expect(screen.getByTestId("outer-backdrop")).not.toHaveAttribute(
      "data-suspended",
    );
    await waitFor(() => expect(innerTrigger).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOuterDismiss).toHaveBeenCalledOnce();
  });

  it("locks body overflow while active and restores the prior value on deactivate", async () => {
    document.body.style.overflow = "scroll";
    const { rerender } = render(sheet());
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

    rerender(sheet({ active: false }));
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("wraps Tab and Shift+Tab focus within the panel", async () => {
    render(sheet());
    await waitFor(() => expect(first()).toHaveFocus());

    last().focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first()).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last()).toHaveFocus();
  });

  it("honors initialFocus", async () => {
    render(
      sheet({
        // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: initialFocus receives the panel container, not a screen query
        initialFocus: (container) => container.querySelector<HTMLElement>("button:nth-of-type(2)"),
      }),
    );
    await waitFor(() => expect(last()).toHaveFocus());
  });

  it("restores focus via returnFocusFallback when the opener is gone at close", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const fallback = document.createElement("button");
    document.body.append(fallback);

    const { rerender, unmount } = render(sheet({ returnFocusFallback: () => fallback }));
    await waitFor(() => expect(first()).toHaveFocus());

    opener.remove();
    rerender(sheet({ active: false, returnFocusFallback: () => fallback }));
    expect(fallback).toHaveFocus();

    unmount();
    fallback.remove();
  });

  it("returns focus to an explicit target instead of ambient focus", async () => {
    const explicitTarget = document.createElement("button");
    const ambientTarget = document.createElement("button");
    document.body.append(explicitTarget, ambientTarget);
    ambientTarget.focus();

    const { rerender, unmount } = render(
      sheet({ returnFocusTo: () => explicitTarget }),
    );
    await waitFor(() => expect(first()).toHaveFocus());
    rerender(sheet({ active: false, returnFocusTo: () => explicitTarget }));
    expect(explicitTarget).toHaveFocus();

    unmount();
    explicitTarget.remove();
    ambientTarget.remove();
  });

  it("Escape calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(sheet({ onDismiss }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("Escape calls onEscape instead of onDismiss when provided", () => {
    const onDismiss = vi.fn();
    const onEscape = vi.fn();
    render(sheet({ onDismiss, onEscape }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("backdrop click dismisses; panel click does not", () => {
    const onDismiss = vi.fn();
    render(sheet({ onDismiss, backdropTestId: "sheet-backdrop" }));

    fireEvent.click(dialog());
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("sheet-backdrop"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("drag down on the grabber past the threshold dismisses", () => {
    const onDismiss = vi.fn();
    render(sheet({ onDismiss }));
    const handle = grabber()!;

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1, bubbles: true });
    fireEvent.pointerMove(handle, { clientY: 197, pointerId: 1, bubbles: true });
    fireEvent.pointerUp(handle, { clientY: 197, pointerId: 1, bubbles: true });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a drag shorter than the threshold snaps back without dismissing", () => {
    const onDismiss = vi.fn();
    render(sheet({ onDismiss }));
    const handle = grabber()!;

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1, bubbles: true });
    fireEvent.pointerMove(handle, { clientY: 140, pointerId: 1, bubbles: true });
    fireEvent.pointerUp(handle, { clientY: 140, pointerId: 1, bubbles: true });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(dialog().style.transform).toBe("");
  });

  it("reduced motion disables drag dismissal", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("reduce"),
          media: query,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          dispatchEvent() {
            return false;
          },
        }) as MediaQueryList,
    );
    const onDismiss = vi.fn();
    render(sheet({ onDismiss }));
    const handle = grabber()!;

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1, bubbles: true });
    fireEvent.pointerMove(handle, { clientY: 197, pointerId: 1, bubbles: true });
    fireEvent.pointerUp(handle, { clientY: 197, pointerId: 1, bubbles: true });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("grabber={false} renders no grabber", () => {
    render(sheet({ grabber: false }));
    expect(grabber()).toBeNull();
  });

  it("--keyboard-inset tracks visualViewport resizes and zeroes sub-threshold values", () => {
    const layoutHeight = window.innerHeight;
    const vv = installFakeViewport(layoutHeight - 300);
    render(sheet());

    expect(dialog().style.getPropertyValue("--keyboard-inset")).toBe("300px");

    resizeViewport(vv, layoutHeight - 60); // at threshold → reported
    expect(dialog().style.getPropertyValue("--keyboard-inset")).toBe("60px");

    resizeViewport(vv, layoutHeight - 59); // below threshold (chrome noise / stale residue) → zeroed
    expect(dialog().style.getPropertyValue("--keyboard-inset")).toBe("0px");
  });

  it("panel bottom lifts and max-height shrinks by the keyboard inset (AC-1/AC-2)", () => {
    // The token stylesheet isn't loaded in component tests; pin the one token
    // the max-height clamp consumes (globals.css: --space-6 = 1.5rem = 24px).
    document.documentElement.style.setProperty("--space-6", "24px");
    const layoutHeight = window.innerHeight;
    const vv = installFakeViewport(layoutHeight - 300);
    render(sheet());
    const panel = dialog();

    expect(getComputedStyle(panel).bottom).toBe("300px");
    expect(parseFloat(getComputedStyle(panel).maxHeight), "max-height must be clamped by 100dvh − inset − 24px").toBeCloseTo(
      Math.min(0.85 * layoutHeight, 720, layoutHeight - 300 - 24),
      0,
    );

    // Keyboard closes → geometry returns exactly to the keyboard-closed state.
    resizeViewport(vv, layoutHeight);
    expect(getComputedStyle(panel).bottom).toBe("0px");
    expect(parseFloat(getComputedStyle(panel).maxHeight), "keyboard-closed max-height must carry no residual offset").toBeCloseTo(
      Math.min(0.85 * layoutHeight, 720, layoutHeight - 24),
      0,
    );
  });

  it("pushes one history entry on activate and does not re-push on rerender", () => {
    const { rerender } = render(sheet());
    expect(history.pushState).toHaveBeenCalledTimes(1);

    rerender(sheet());
    expect(history.pushState).toHaveBeenCalledTimes(1);
  });

  it("popstate (back button) dismisses exactly once and does not pop again", async () => {
    const onDismiss = vi.fn();
    render(sheet({ onDismiss }));

    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await flushMicrotasks();

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(history.back).not.toHaveBeenCalled(); // the browser already removed the entry
  });

  it("UI close pops the synthetic entry; re-activating pushes a fresh one", async () => {
    const { rerender } = render(sheet());
    expect(history.pushState).toHaveBeenCalledTimes(1);

    rerender(sheet({ active: false }));
    await flushMicrotasks();
    expect(history.back).toHaveBeenCalledTimes(1);

    rerender(sheet());
    expect(history.pushState).toHaveBeenCalledTimes(2);
  });

  it("onDismissRequest 'blocked' vetoes backdrop, Escape, and drag dismissal", () => {
    const onDismiss = vi.fn();
    const onDismissRequest = vi.fn(() => "blocked" as const);
    render(sheet({ onDismiss, onDismissRequest, backdropTestId: "sheet-backdrop" }));

    fireEvent.click(screen.getByTestId("sheet-backdrop"));
    expect(onDismissRequest).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismissRequest).toHaveBeenCalledTimes(2);
    expect(onDismiss).not.toHaveBeenCalled();

    const handle = grabber()!;
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1, bubbles: true });
    fireEvent.pointerMove(handle, { clientY: 197, pointerId: 1, bubbles: true });
    fireEvent.pointerUp(handle, { clientY: 197, pointerId: 1, bubbles: true });
    expect(onDismissRequest).toHaveBeenCalledTimes(3);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("onDismissRequest 'accepted' dismisses via onDismiss", () => {
    const onDismiss = vi.fn();
    const onDismissRequest = vi.fn(() => "accepted" as const);
    render(sheet({ onDismiss, onDismissRequest, backdropTestId: "sheet-backdrop" }));

    fireEvent.click(screen.getByTestId("sheet-backdrop"));
    expect(onDismissRequest).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a blocked back button re-arms the history marker and does not dismiss", async () => {
    const onDismiss = vi.fn();
    const onDismissRequest = vi.fn(() => "blocked" as const);
    render(sheet({ onDismiss, onDismissRequest }));
    expect(history.pushState).toHaveBeenCalledTimes(1);

    fakeState = null; // the browser popped our entry before firing popstate
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await flushMicrotasks();

    expect(onDismissRequest).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(history.pushState).toHaveBeenCalledTimes(2); // re-armed
  });

  it("historyDismiss={false} opts out of history wiring", () => {
    const onDismiss = vi.fn();
    render(sheet({ onDismiss, historyDismiss: false }));
    expect(history.pushState).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
