import { useRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
