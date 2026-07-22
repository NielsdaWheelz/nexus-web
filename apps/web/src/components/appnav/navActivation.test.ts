import { describe, expect, it, vi } from "vitest";
import {
  handleAppNavLinkActivation,
  type AppNavActivationEvent,
} from "./navActivation";

function activationEvent(
  overrides: Partial<AppNavActivationEvent> = {},
): AppNavActivationEvent {
  return {
    altKey: false,
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    preventDefault: vi.fn(),
    shiftKey: false,
    ...overrides,
  };
}

describe("app nav link activation", () => {
  it("claims a plain primary activation for workspace pane navigation", () => {
    const event = activationEvent();
    const activate = vi.fn(() => "handled-destination-focus" as const);

    expect(handleAppNavLinkActivation(event, "/lectern", activate)).toBe(
      "handled-destination-focus",
    );
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith("/lectern");
  });

  it.each([
    ["already prevented", { defaultPrevented: true }],
    ["middle click", { button: 1 }],
    ["meta click", { metaKey: true }],
    ["control click", { ctrlKey: true }],
    ["alt click", { altKey: true }],
    ["shift click", { shiftKey: true }],
  ])("leaves %s to the browser", (_label, overrides) => {
    const event = activationEvent(overrides);
    const activate = vi.fn(() => "handled-destination-focus" as const);

    expect(handleAppNavLinkActivation(event, "/lectern", activate)).toBe("unhandled");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("leaves unsupported hrefs to native navigation", () => {
    const event = activationEvent();
    const activate = vi.fn(() => "handled-destination-focus" as const);

    expect(handleAppNavLinkActivation(event, "/not-a-pane", activate)).toBe(
      "unhandled",
    );
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("preserves source-focus ownership from the navigation coordinator", () => {
    const event = activationEvent();

    expect(
      handleAppNavLinkActivation(
        event,
        "/libraries",
        () => "handled-source-focus",
      ),
    ).toBe("handled-source-focus");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});
