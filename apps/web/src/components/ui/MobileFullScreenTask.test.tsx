import { useRef, useState, type ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cdp, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import Dialog from "./Dialog";
import MobileFullScreenTask from "./MobileFullScreenTask";

const noop = () => {};

function task(
  props: Partial<ComponentProps<typeof MobileFullScreenTask>> = {},
) {
  return withRenderEnvironment(
    <MobileFullScreenTask
      active
      onDismiss={noop}
      onDismissRequest={() => "accepted"}
      ariaLabel="Test task"
      initialFocus={(container) => {
        return container.querySelector<HTMLElement>("[data-initial-focus]");
      }}
      focusKey="root"
      {...props}
    >
      <h1 tabIndex={-1} data-initial-focus>
        Task title
      </h1>
      <button type="button">Task action</button>
    </MobileFullScreenTask>,
    { initialViewport: "mobile" },
  );
}

function dialog(name = "Test task") {
  return screen.getByRole("dialog", { name });
}

function projection(name = "Test task") {
  return dialog(name).parentElement as HTMLElement;
}

function installFakeViewport(height: number, offsetTop: number) {
  const viewport = new EventTarget() as EventTarget & {
    height: number;
    offsetTop: number;
  };
  viewport.height = height;
  viewport.offsetTop = offsetTop;
  Object.defineProperty(window, "visualViewport", {
    value: viewport,
    configurable: true,
  });
  return viewport;
}

function updateFakeViewport(
  viewport: ReturnType<typeof installFakeViewport>,
  height: number,
  offsetTop: number,
) {
  act(() => {
    viewport.height = height;
    viewport.offsetTop = offsetTop;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
  });
}

function OpenCloseTask() {
  const [active, setActive] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setActive(true)}>
        Open task
      </button>
      <MobileFullScreenTask
        active={active}
        onDismiss={() => setActive(false)}
        onDismissRequest={() => "accepted"}
        ariaLabel="Open task"
        initialFocus={(container) => {
          return container.querySelector<HTMLElement>("h1");
        }}
        focusKey="root"
      >
        <h1 tabIndex={-1}>Focused task</h1>
        <button type="button">Continue</button>
      </MobileFullScreenTask>
    </>
  );
}

function TaskWithDialog({
  onOuterDismiss,
  onInnerDismiss,
}: {
  onOuterDismiss(): void;
  onInnerDismiss(): void;
}) {
  const [outerActive, setOuterActive] = useState(true);
  const [innerActive, setInnerActive] = useState(false);
  const innerTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <MobileFullScreenTask
        active={outerActive}
        onDismiss={() => {
          onOuterDismiss();
          setOuterActive(false);
        }}
        onDismissRequest={() => "accepted"}
        ariaLabel="Outer task"
        initialFocus={() => innerTriggerRef.current}
        focusKey="outer"
      >
        <h1>Outer</h1>
        <button
          ref={innerTriggerRef}
          type="button"
          onClick={() => setInnerActive(true)}
        >
          Open confirmation
        </button>
        <Dialog
          open={innerActive}
          historyDismiss
          onClose={() => {
            onInnerDismiss();
            setInnerActive(false);
          }}
          title="Confirmation"
          returnFocusTo={() => innerTriggerRef.current}
          initialFocus={(container) => {
            return container.querySelector<HTMLElement>("[data-confirm]");
          }}
        >
          <button type="button" data-confirm>
            Confirm
          </button>
        </Dialog>
      </MobileFullScreenTask>
    </>
  );
}

describe("MobileFullScreenTask", () => {
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
    document.documentElement.style.setProperty("--z-nexus", "1100");
    document.documentElement.style.setProperty(
      "--surface-canvas",
      "rgb(24, 26, 30)",
    );
    document.documentElement.style.setProperty("--ink", "rgb(244, 244, 245)");
  });

  afterEach(() => {
    document.body.style.overflow = "";
    Reflect.deleteProperty(window, "visualViewport");
    document.documentElement.style.removeProperty("--z-nexus");
    document.documentElement.style.removeProperty("--surface-canvas");
    document.documentElement.style.removeProperty("--ink");
  });

  it("keeps an inactive mounted task outside viewport context inert", () => {
    render(
      <MobileFullScreenTask
        active={false}
        onDismiss={noop}
        onDismissRequest={() => "accepted"}
        ariaLabel="Inactive task"
        initialFocus={() => null}
        focusKey="inactive"
      >
        <h1>Inactive content</h1>
      </MobileFullScreenTask>,
    );

    expect(
      screen.queryByRole("dialog", { name: "Inactive task" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Inactive content")).not.toBeInTheDocument();
  });

  it("renders an unpainted Nexus projection around one opaque dialog frame", () => {
    const onDismiss = vi.fn();
    render(task({ onDismiss }));

    const frame = dialog();
    const wrapper = projection();
    expect(frame).toHaveAttribute("aria-modal", "true");
    expect(wrapper).toHaveAttribute("data-modal-backdrop", "true");
    expect(wrapper).not.toHaveAttribute("data-suspended");
    expect(getComputedStyle(wrapper).position).toBe("fixed");
    expect(getComputedStyle(wrapper).zIndex).toBe("1100");
    expect(getComputedStyle(wrapper).backgroundColor).toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(getComputedStyle(frame).backgroundColor).toBe("rgb(24, 26, 30)");
    expect(getComputedStyle(frame).animationName).toBe("none");
    expect(getComputedStyle(frame).opacity).toBe("1");
    expect(getComputedStyle(frame).transform).toBe("none");

    fireEvent.click(wrapper);
    expect(onDismiss).not.toHaveBeenCalled();
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the removed grabber is decorative and intentionally has no accessible query
    expect(document.querySelector("[data-grabber]")).toBeNull();
  });

  it("shows task content at its final state without animation when motion is reduced", async () => {
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      render(task());
      const heading = screen.getByRole("heading", { name: "Task title" });
      // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the animated content wrapper is intentionally presentation-only; its computed style is the reduced-motion contract.
      const content = heading.parentElement;
      if (!content) throw new Error("Task heading requires its content frame.");
      expect(getComputedStyle(content).animationName).toBe("none");
      expect(getComputedStyle(content).opacity).toBe("1");
      expect(getComputedStyle(content).transform).toBe("none");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: "no-preference" },
        ],
      });
    }
  });

  it("tracks the unobscured visual viewport at both vertical edges", () => {
    const layoutHeight = window.innerHeight;
    const viewport = installFakeViewport(layoutHeight - 320, 40);
    render(task());

    let wrapper = projection();
    let frame = dialog();
    expect(getComputedStyle(wrapper).top).toBe("40px");
    expect(getComputedStyle(wrapper).bottom).toBe("280px");
    expect(frame.getBoundingClientRect().top).toBeCloseTo(40, 1);
    expect(frame.getBoundingClientRect().bottom).toBeCloseTo(
      40 + viewport.height,
      1,
    );

    updateFakeViewport(viewport, layoutHeight - 240, 24);
    wrapper = projection();
    frame = dialog();
    expect(getComputedStyle(wrapper).top).toBe("24px");
    expect(getComputedStyle(wrapper).bottom).toBe("216px");
    expect(frame.getBoundingClientRect().top).toBeCloseTo(24, 1);
    expect(frame.getBoundingClientRect().bottom).toBeCloseTo(
      24 + viewport.height,
      1,
    );
  });

  it("focuses the requested task target and restores its opener after Escape", async () => {
    render(
      withRenderEnvironment(<OpenCloseTask />, {
        initialViewport: "mobile",
      }),
    );
    const opener = screen.getByRole("button", { name: "Open task" });

    await userEvent.click(opener);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Focused task" }),
      ).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Open task" })).toBeNull(),
    );
    expect(opener).toHaveFocus();
  });

  it("keeps blocked Escape and browser Back requests inside the task", () => {
    const onDismiss = vi.fn();
    const onDismissRequest = vi.fn(() => "blocked" as const);
    render(task({ onDismiss, onDismissRequest }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismissRequest).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(dialog()).toBeVisible();

    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onDismissRequest).toHaveBeenCalledTimes(2);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(dialog()).toBeVisible();
  });

  it("keeps its suspended canvas opaque beneath the actual nested Dialog", async () => {
    const onOuterDismiss = vi.fn();
    const onInnerDismiss = vi.fn();
    render(
      withRenderEnvironment(
        <TaskWithDialog
          onOuterDismiss={onOuterDismiss}
          onInnerDismiss={onInnerDismiss}
        />,
        { initialViewport: "mobile" },
      ),
    );

    const trigger = screen.getByRole("button", {
      name: "Open confirmation",
    });
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus(),
    );

    const outer = dialog("Outer task");
    const inner = dialog("Confirmation");
    const outerProjection = projection("Outer task");
    const innerProjection = projection("Confirmation");
    expect(outer).toHaveAttribute("inert");
    expect(outer).not.toHaveAttribute("aria-modal");
    expect(outerProjection).toHaveAttribute("data-suspended", "true");
    expect(getComputedStyle(outer).backgroundColor).toBe("rgb(24, 26, 30)");
    expect(inner).toHaveAttribute("aria-modal", "true");
    expect(
      Number(getComputedStyle(innerProjection).zIndex),
    ).toBeGreaterThanOrEqual(
      Number(getComputedStyle(outerProjection).zIndex),
    );

    fakeState = null;
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onInnerDismiss).toHaveBeenCalledOnce();
    expect(onOuterDismiss).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Confirmation" })).toBeNull(),
    );
    expect(outer).not.toHaveAttribute("inert");
    expect(outer).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(trigger).toHaveFocus());

    await userEvent.click(trigger);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus(),
    );
    expect(outer).toHaveAttribute("inert");
    expect(outerProjection).toHaveAttribute("data-suspended", "true");
    expect(getComputedStyle(outer).backgroundColor).toBe("rgb(24, 26, 30)");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onInnerDismiss).toHaveBeenCalledTimes(2);
    expect(onOuterDismiss).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Confirmation" })).toBeNull(),
    );
    expect(dialog("Outer task")).toBeVisible();
    expect(outer).not.toHaveAttribute("inert");
    expect(outer).toHaveAttribute("aria-modal", "true");
    expect(outerProjection).not.toHaveAttribute("data-suspended");
    expect(getComputedStyle(outer).backgroundColor).toBe("rgb(24, 26, 30)");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
