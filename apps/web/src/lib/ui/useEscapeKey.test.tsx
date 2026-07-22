import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  hasActiveInteractionOwner,
  isTopmostInteractionOwner,
  useEscapeKey,
} from "./useEscapeKey";
import { useModalLayer } from "./useModalLayer";

describe("useEscapeKey", () => {
  it("dispatches Escape to only the latest peer owner", () => {
    const first = vi.fn();
    const second = vi.fn();
    renderHook(() => {
      useEscapeKey(true, first, { layer: "transient", modalToken: null });
      useEscapeKey(true, second, { layer: "transient", modalToken: null });
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("skips an ineligible peer and dispatches to the latest eligible owner", () => {
    const first = vi.fn();
    const second = vi.fn();
    renderHook(() => {
      useEscapeKey(true, first, {
        layer: "transient",
        modalToken: null,
      });
      useEscapeKey(true, second, {
        layer: "transient",
        modalToken: null,
        isEligible: () => false,
      });
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("gives a transient owner priority over its modal regardless of effect order", () => {
    const transient = vi.fn();
    const modal = vi.fn();
    renderHook(() => {
      const modalLayer = useModalLayer(true);
      useEscapeKey(true, transient, {
        layer: "transient",
        modalToken: modalLayer.token,
      });
      useEscapeKey(true, modal, {
        layer: "modal",
        modalToken: modalLayer.token,
      });
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(transient).toHaveBeenCalledTimes(1);
    expect(modal).not.toHaveBeenCalled();
  });

  it("projects the top interaction scope across transient activation", () => {
    const { rerender, unmount } = renderHook(
      ({ transient }) => {
        const modalLayer = useModalLayer(true);
        useEscapeKey(true, vi.fn(), {
          layer: "modal",
          modalToken: modalLayer.token,
          scope: "reader-tools",
        });
        useEscapeKey(transient, vi.fn(), {
          layer: "transient",
          modalToken: modalLayer.token,
        });
      },
      { initialProps: { transient: false } },
    );
    expect(hasActiveInteractionOwner()).toBe(true);
    expect(isTopmostInteractionOwner("reader-tools")).toBe(true);

    rerender({ transient: true });
    expect(isTopmostInteractionOwner("reader-tools")).toBe(false);

    rerender({ transient: false });
    expect(isTopmostInteractionOwner("reader-tools")).toBe(true);
    unmount();
    expect(hasActiveInteractionOwner()).toBe(false);
  });

  it("does not let an outer transient steal Escape from a nested modal", () => {
    const outerTransient = vi.fn();
    const innerModal = vi.fn();
    const { unmount: unmountOuter } = renderHook(() => {
      const modalLayer = useModalLayer(true);
      useEscapeKey(true, vi.fn(), {
        layer: "modal",
        modalToken: modalLayer.token,
      });
      useEscapeKey(true, outerTransient, {
        layer: "transient",
        modalToken: modalLayer.token,
      });
    });
    const { unmount: unmountInner } = renderHook(() => {
      const modalLayer = useModalLayer(true);
      useEscapeKey(true, innerModal, {
        layer: "modal",
        modalToken: modalLayer.token,
      });
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(innerModal).toHaveBeenCalledTimes(1);
    expect(outerTransient).not.toHaveBeenCalled();
    unmountInner();
    unmountOuter();
  });

  it("respects an Escape already consumed by a local control", () => {
    const onEscape = vi.fn();
    renderHook(() =>
      useEscapeKey(true, onEscape, {
        layer: "transient",
        modalToken: null,
      }),
    );
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    document.dispatchEvent(event);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("leaves Escape to an active IME composition", () => {
    const onEscape = vi.fn();
    renderHook(() =>
      useEscapeKey(true, onEscape, {
        layer: "transient",
        modalToken: null,
      }),
    );
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    document.dispatchEvent(event);
    expect(onEscape).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
