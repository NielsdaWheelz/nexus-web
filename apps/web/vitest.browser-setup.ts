import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, vi } from "vitest";

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
    currentInstant: "2026-06-03T12:00:00.000Z",
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
      // RenderEnvironmentProvider's required-children props make the
      // createElement children argument type-incompatible.
      // eslint-disable-next-line react/no-children-prop
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

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const WEBSOCKET_PROTOCOLS = new Set(["ws:", "wss:"]);
const NATIVE_FETCH = globalThis.fetch.bind(globalThis);
const NATIVE_EVENT_SOURCE = globalThis.EventSource;
const NATIVE_WEB_SOCKET = globalThis.WebSocket;

function assertApplicationOrigin(
  input: string | URL | Request,
  protocols: ReadonlySet<string>,
  boundary: string,
) {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.href,
  );
  const expected = new URL(window.location.origin);
  if (WEBSOCKET_PROTOCOLS.has(url.protocol)) {
    expected.protocol = expected.protocol === "https:" ? "wss:" : "ws:";
  }
  if (!protocols.has(url.protocol) || url.origin !== expected.origin) {
    throw new Error(`Blocked external ${boundary} origin: ${url.origin}`);
  }
}

function installApplicationNetworkGuards() {
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit) => {
      assertApplicationOrigin(input, HTTP_PROTOCOLS, "fetch");
      return NATIVE_FETCH(input, init);
    },
  );

  vi.stubGlobal(
    "EventSource",
    new Proxy(NATIVE_EVENT_SOURCE, {
      construct(target, args, newTarget) {
        assertApplicationOrigin(
          args[0] as string | URL,
          HTTP_PROTOCOLS,
          "EventSource",
        );
        return Reflect.construct(target, args, newTarget);
      },
    }),
  );

  vi.stubGlobal(
    "WebSocket",
    new Proxy(NATIVE_WEB_SOCKET, {
      construct(target, args, newTarget) {
        assertApplicationOrigin(
          args[0] as string | URL,
          WEBSOCKET_PROTOCOLS,
          "WebSocket",
        );
        return Reflect.construct(target, args, newTarget);
      },
    }),
  );
}

// These guards cover application calls made through this JavaScript global.
// They are not transport isolation: Chromium subresources, workers, extensions,
// and a saved native reference need the Playwright/runtime network boundary.
installApplicationNetworkGuards();
beforeEach(installApplicationNetworkGuards);

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

function installViewportSafeAreaInsets() {
  // globals.css sources --viewport-safe-* from env(safe-area-inset-*), which the
  // browser test document does not define; the product's strict inset validation
  // (viewportSafeArea.ts) then rejects the unresolved value. Provide the zero
  // desktop baseline so anchored surfaces render as they do without device insets.
  for (const edge of ["top", "right", "bottom", "left"]) {
    document.documentElement.style.setProperty(`--viewport-safe-${edge}`, "0px");
  }
}

installViewportSafeAreaInsets();
beforeEach(installViewportSafeAreaInsets);

afterEach(async () => {
  vi.useRealTimers();
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  installMatchMedia();
});
