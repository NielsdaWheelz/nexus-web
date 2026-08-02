import { useRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";

type HostProps = Omit<Parameters<typeof useDialogOverlay>[0], "ref">;

/**
 * Opener button + a panel with two focusable elements, wired to the hook. The
 * opener stays outside the trapped `ref` so focus-restore lands back on it.
 */
function Host(props: HostProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogOverlay({ ref, ...props });
  return (
    <>
      <button type="button">Open</button>
      <div ref={ref}>
        <h2 tabIndex={-1}>Title</h2>
        <button type="button">First</button>
        <button type="button">Last</button>
      </div>
    </>
  );
}

const opener = () => screen.getByRole("button", { name: "Open" });
const title = () => screen.getByRole("heading", { name: "Title" });
const first = () => screen.getByRole("button", { name: "First" });
const last = () => screen.getByRole("button", { name: "Last" });

describe("useDialogOverlay", () => {
  afterEach(() => {
    document.body.style.overflow = "";
    document.body.removeAttribute("tabindex");
  });

  it("locks body scroll while active and restores the prior value on deactivate", async () => {
    document.body.style.overflow = "scroll";
    const { rerender } = render(<Host active onDismiss={vi.fn()} />);
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

    rerender(<Host active={false} onDismiss={vi.fn()} />);
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("restores the prior overflow on unmount", async () => {
    document.body.style.overflow = "scroll";
    const { unmount } = render(<Host active onDismiss={vi.fn()} />);
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

    unmount();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("moves focus to the first focusable on open", async () => {
    render(<Host active onDismiss={vi.fn()} />);
    await waitFor(() => expect(first()).toHaveFocus());
  });

  it("uses initialFocus(container) when provided", async () => {
    render(
      <Host active onDismiss={vi.fn()} initialFocus={() => last()} />,
    );
    await waitFor(() => expect(last()).toHaveFocus());
  });

  it("falls back to the first focusable when initialFocus returns null", async () => {
    render(<Host active onDismiss={vi.fn()} initialFocus={() => null} />);
    await waitFor(() => expect(first()).toHaveFocus());
  });

  it("re-runs focus-in when focusKey changes", async () => {
    const { rerender } = render(
      <Host active onDismiss={vi.fn()} focusKey="a" />,
    );
    await waitFor(() => expect(first()).toHaveFocus());

    last().focus();
    rerender(<Host active onDismiss={vi.fn()} focusKey="b" />);
    await waitFor(() => expect(first()).toHaveFocus());
  });

  it("restores focus to the opener on close", async () => {
    const { rerender } = render(<Host active={false} onDismiss={vi.fn()} />);
    opener().focus();
    rerender(<Host active onDismiss={vi.fn()} />);
    await waitFor(() => expect(first()).toHaveFocus());

    rerender(<Host active={false} onDismiss={vi.fn()} />);
    expect(opener()).toHaveFocus();
  });

  it("reasserts return focus after native dismissal settles on the document", async () => {
    const { rerender } = render(<Host active={false} onDismiss={vi.fn()} />);
    opener().focus();
    rerender(<Host active onDismiss={vi.fn()} />);
    await waitFor(() => expect(first()).toHaveFocus());

    rerender(<Host active={false} onDismiss={vi.fn()} />);
    expect(opener()).toHaveFocus();
    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.body).toHaveFocus();

    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    expect(opener()).toHaveFocus();
    document.body.removeAttribute("tabindex");
  });

  it("prefers an explicit return-focus target over ambient focus", async () => {
    const explicitTarget = document.createElement("button");
    document.body.append(explicitTarget);
    const { rerender, unmount } = render(
      <Host active={false} onDismiss={vi.fn()} returnFocusTo={() => explicitTarget} />,
    );
    opener().focus();
    rerender(<Host active onDismiss={vi.fn()} returnFocusTo={() => explicitTarget} />);
    await waitFor(() => expect(first()).toHaveFocus());

    rerender(
      <Host active={false} onDismiss={vi.fn()} returnFocusTo={() => explicitTarget} />,
    );
    expect(explicitTarget).toHaveFocus();

    unmount();
    explicitTarget.remove();
  });

  it("uses returnFocusFallback when the opener is disconnected at close time", async () => {
    const detachableOpener = document.createElement("button");
    document.body.append(detachableOpener);
    detachableOpener.focus();

    const fallback = document.createElement("button");
    document.body.append(fallback);

    const { rerender, unmount } = render(
      <Host active onDismiss={vi.fn()} returnFocusFallback={() => fallback} />,
    );
    await waitFor(() => expect(first()).toHaveFocus());

    detachableOpener.remove();
    rerender(
      <Host
        active={false}
        onDismiss={vi.fn()}
        returnFocusFallback={() => fallback}
      />,
    );
    expect(fallback).toHaveFocus();

    unmount();
    fallback.remove();
  });

  it("uses the fallback when an explicit target disconnects", async () => {
    const explicitTarget = document.createElement("button");
    const fallback = document.createElement("button");
    document.body.append(explicitTarget, fallback);
    const { rerender, unmount } = render(
      <Host
        active
        onDismiss={vi.fn()}
        returnFocusTo={() => explicitTarget}
        returnFocusFallback={() => fallback}
      />,
    );
    await waitFor(() => expect(first()).toHaveFocus());

    explicitTarget.remove();
    rerender(
      <Host
        active={false}
        onDismiss={vi.fn()}
        returnFocusTo={() => explicitTarget}
        returnFocusFallback={() => fallback}
      />,
    );
    expect(fallback).toHaveFocus();

    unmount();
    fallback.remove();
  });

  it("re-resolves a logical return target when its mounted node is replaced", async () => {
    let currentTarget = document.createElement("button");
    document.body.append(currentTarget);
    const { rerender, unmount } = render(
      <Host
        active
        onDismiss={vi.fn()}
        returnFocusTo={() => currentTarget}
      />,
    );
    await waitFor(() => expect(first()).toHaveFocus());

    currentTarget.remove();
    currentTarget = document.createElement("button");
    document.body.append(currentTarget);
    rerender(
      <Host
        active={false}
        onDismiss={vi.fn()}
        returnFocusTo={() => currentTarget}
      />,
    );
    expect(currentTarget).toHaveFocus();

    unmount();
    currentTarget.remove();
  });

  it("skips return focus when the destination already claimed it", async () => {
    const destination = document.createElement("button");
    document.body.append(destination);
    const { rerender, unmount } = render(
      <Host active={false} onDismiss={vi.fn()} skipReturnFocus={() => true} />,
    );
    opener().focus();
    rerender(<Host active onDismiss={vi.fn()} skipReturnFocus={() => true} />);
    await waitFor(() => expect(first()).toHaveFocus());
    destination.focus();

    rerender(<Host active={false} onDismiss={vi.fn()} skipReturnFocus={() => true} />);
    expect(destination).toHaveFocus();

    unmount();
    destination.remove();
  });

  it("calls onDismiss and preventDefaults on Escape", async () => {
    const onDismiss = vi.fn();
    render(<Host active onDismiss={onDismiss} />);
    await waitFor(() => expect(first()).toHaveFocus());

    // fireEvent returns false when the event was defaultPrevented.
    const notPrevented = fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it("wraps focus with Tab and Shift+Tab within the panel", async () => {
    render(<Host active onDismiss={vi.fn()} />);
    await waitFor(() => expect(first()).toHaveFocus());

    last().focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first()).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last()).toHaveFocus();
  });

  it("wraps focus from a non-tabbable initial focus target", async () => {
    render(<Host active onDismiss={vi.fn()} initialFocus={() => title()} />);
    await waitFor(() => expect(title()).toHaveFocus());

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last()).toHaveFocus();

    title().focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first()).toHaveFocus();
  });

  it("composes nested locks, restoring the prior overflow only after both release", async () => {
    document.body.style.overflow = "scroll";
    const { rerender } = render(
      <>
        <Host active onDismiss={vi.fn()} />
        <Host active onDismiss={vi.fn()} />
      </>,
    );
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

    // Inner lock releases — the outer keeps scroll hidden.
    rerender(
      <>
        <Host active onDismiss={vi.fn()} />
        <Host active={false} onDismiss={vi.fn()} />
      </>,
    );
    expect(document.body.style.overflow).toBe("hidden");

    // Outer lock releases — the original value is restored.
    rerender(
      <>
        <Host active={false} onDismiss={vi.fn()} />
        <Host active={false} onDismiss={vi.fn()} />
      </>,
    );
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("keeps body locked when an underlying overlay releases first", async () => {
    document.body.style.overflow = "scroll";
    const { rerender } = render(
      <>
        <Host active onDismiss={vi.fn()} />
        <Host active onDismiss={vi.fn()} />
      </>,
    );
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));

    rerender(
      <>
        <Host active={false} onDismiss={vi.fn()} />
        <Host active onDismiss={vi.fn()} />
      </>,
    );
    expect(document.body.style.overflow).toBe("hidden");

    rerender(
      <>
        <Host active={false} onDismiss={vi.fn()} />
        <Host active={false} onDismiss={vi.fn()} />
      </>,
    );
    expect(document.body.style.overflow).toBe("scroll");
  });
});
