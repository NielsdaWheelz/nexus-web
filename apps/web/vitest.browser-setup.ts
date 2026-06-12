import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import type { ComponentType, ReactNode } from "react";
import { afterEach } from "vitest";
import { vi } from "vitest";

vi.mock("next/image", () => ({
  __esModule: true,
  default: ({
    src,
    alt,
    priority: _priority,
    unoptimized: _unoptimized,
    ...props
  }: {
    src: string | { src: string };
    alt: string;
    priority?: boolean;
    unoptimized?: boolean;
    [key: string]: unknown;
  }) =>
    createElement("img", {
      ...props,
      alt,
      src: typeof src === "string" ? src : src.src,
      "data-unoptimized": _unoptimized ? "" : undefined,
    }),
}));

vi.mock("@testing-library/react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@testing-library/react")>();
  const { RenderEnvironmentProvider } = await import(
    "./src/lib/renderEnvironment/provider"
  );

  const defaultRenderEnvironment = {
    androidShell: false,
    platform: "other",
    displayLocale: "en-US",
    displayTimeZone: "UTC",
    currentLocalDate: "2026-06-03",
    initialViewport: "desktop",
  } as const;

  type Wrapper = ComponentType<{ children: ReactNode }>;

  function withBrowserRenderEnvironment(wrapper?: Wrapper): Wrapper {
    return function BrowserRenderEnvironmentWrapper({
      children,
    }: {
      children: ReactNode;
    }) {
      const wrapped = wrapper ? createElement(wrapper, null, children) : children;
      return createElement(
        RenderEnvironmentProvider,
        { value: defaultRenderEnvironment, children: wrapped },
      );
    };
  }

  const render = ((
    ui: Parameters<typeof actual.render>[0],
    options?: Parameters<typeof actual.render>[1] & { wrapper?: Wrapper },
  ) =>
    actual.render(ui, {
      ...options,
      wrapper: withBrowserRenderEnvironment(options?.wrapper),
    } as Parameters<typeof actual.render>[1])) as typeof actual.render;

  const renderHook = ((
    renderCallback: Parameters<typeof actual.renderHook>[0],
    options?: Parameters<typeof actual.renderHook>[1] & { wrapper?: Wrapper },
  ) =>
    actual.renderHook(renderCallback, {
      ...options,
      wrapper: withBrowserRenderEnvironment(options?.wrapper),
    } as Parameters<typeof actual.renderHook>[1])) as typeof actual.renderHook;

  return {
    ...actual,
    render,
    renderHook,
  };
});

function queryMatchesViewport(query: string): boolean {
  const maxWidth = query.match(/\(\s*max-width\s*:\s*(\d+)px\s*\)/);
  if (maxWidth) {
    return window.innerWidth <= Number(maxWidth[1]);
  }

  const minWidth = query.match(/\(\s*min-width\s*:\s*(\d+)px\s*\)/);
  if (minWidth) {
    return window.innerWidth >= Number(minWidth[1]);
  }

  return false;
}

function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const listeners = new Set<(event: MediaQueryListEvent) => void>();
      let resizeListener: (() => void) | null = null;
      let onchange: ((event: MediaQueryListEvent) => void) | null = null;

      const mediaQueryList = {
        get matches() {
          return queryMatchesViewport(query);
        },
        media: query,
        get onchange() {
          return onchange;
        },
        set onchange(listener) {
          onchange = listener;
          syncResizeListener();
        },
        addEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject,
        ) => {
          if (type !== "change") return;
          listeners.add(listener as (event: MediaQueryListEvent) => void);
          syncResizeListener();
        },
        removeEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject,
        ) => {
          if (type !== "change") return;
          listeners.delete(listener as (event: MediaQueryListEvent) => void);
          syncResizeListener();
        },
        addListener: (listener: (event: MediaQueryListEvent) => void) => {
          listeners.add(listener);
          syncResizeListener();
        },
        removeListener: (listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener);
          syncResizeListener();
        },
        dispatchEvent: (event: Event) => {
          listeners.forEach((listener) =>
            listener.call(mediaQueryList, event as MediaQueryListEvent),
          );
          onchange?.call(mediaQueryList, event as MediaQueryListEvent);
          return true;
        },
      } satisfies MediaQueryList;

      function syncResizeListener() {
        const hasListeners = listeners.size > 0 || onchange != null;
        if (hasListeners && !resizeListener) {
          resizeListener = () => {
            const event = new Event("change") as MediaQueryListEvent;
            Object.defineProperties(event, {
              matches: { value: mediaQueryList.matches },
              media: { value: query },
            });
            mediaQueryList.dispatchEvent(event);
          };
          window.addEventListener("resize", resizeListener);
        } else if (!hasListeners && resizeListener) {
          window.removeEventListener("resize", resizeListener);
          resizeListener = null;
        }
      }

      return mediaQueryList;
    },
  });
}

installMatchMedia();

afterEach(async () => {
  vi.useRealTimers();
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  installMatchMedia();
});
