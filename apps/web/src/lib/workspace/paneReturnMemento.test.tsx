import {
  StrictMode,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assumePaneVisitId, type PaneVisitId } from "./schema";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneResolvedBodyReady,
  usePaneReturnDescendantReady,
  usePaneReturnMementoCommands,
  usePaneReturnReady,
  usePaneReturnScrollport,
  usePaneVisitData,
  type PaneReturnMementoCommands,
} from "./paneReturnMemento";

const VISIT_1 = assumePaneVisitId("11111111-1111-4111-8111-111111111111");
const VISIT_2 = assumePaneVisitId("22222222-2222-4222-8222-222222222222");
const ROUTE_KEY = "library:/libraries/one";
const DATA_KEY = definePaneVisitDataKey<{ readonly page: number }>(
  "Library.Pagination",
);
const OVERSIZED_DATA_KEY = definePaneVisitDataKey<{
  readonly payload: string;
}>("Library.OversizedPagination");
const BUDGET_DATA_KEY = definePaneVisitDataKey<{
  readonly payload: string;
}>("Library.BudgetPagination");

function CommandsProbe({
  publish,
}: {
  publish: (commands: PaneReturnMementoCommands) => void;
}) {
  const commands = usePaneReturnMementoCommands();
  useLayoutEffect(() => publish(commands), [commands, publish]);
  return null;
}

function defineGeometry(
  scrollport: HTMLElement,
  contentHeight: number,
): void {
  let scrollTop = 0;
  Object.defineProperties(scrollport, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: {
      configurable: true,
      get: () => contentHeight,
    },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
  });
  scrollport.getBoundingClientRect = () =>
    ({
      top: 0,
      right: 200,
      bottom: 100,
      left: 0,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  for (const row of scrollport.querySelectorAll<HTMLElement>(
    "[data-mock-top]",
  )) {
    row.getBoundingClientRect = () => {
      const top = Number(row.dataset.mockTop) - scrollport.scrollTop;
      return {
        top,
        right: 200,
        bottom: top + 40,
        left: 0,
        width: 200,
        height: 40,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
  }
}

function ScrollRoute({
  paneId,
  visitId,
  ready,
  contentHeight,
  rows,
  anchorKind = "collection",
  resolved = true,
  descendantReady = null,
  portalDescendantReady = null,
  heading = false,
}: {
  paneId: string;
  visitId: PaneVisitId;
  ready: boolean;
  contentHeight: number;
  rows?: readonly { readonly id: string; readonly top: number }[];
  anchorKind?: "collection" | "note";
  resolved?: boolean;
  descendantReady?: boolean | null;
  portalDescendantReady?: boolean | null;
  heading?: boolean;
}) {
  const scrollportRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollportRef.current) {
      defineGeometry(scrollportRef.current, contentHeight);
    }
  }, [contentHeight, rows, visitId]);
  usePaneReturnScrollport({
    paneId,
    enabled: true,
    scrollportRef,
  });
  return (
    <section data-pane-shell>
      <button data-pane-chrome-focus type="button">
        Pane chrome
      </button>
      <div ref={scrollportRef} data-testid="scrollport">
        <div key={visitId}>
          {resolved ? (
            <ResolvedReady>
              <RouteContents
                ready={ready}
                descendantReady={descendantReady}
                heading={heading}
                rows={rows}
                anchorKind={anchorKind}
              />
            </ResolvedReady>
          ) : (
            <RouteContents
              ready={ready}
              descendantReady={descendantReady}
              heading={heading}
              rows={rows}
              anchorKind={anchorKind}
            />
          )}
        </div>
      </div>
      {portalDescendantReady === null
        ? null
        : createPortal(
            <DescendantReady ready={portalDescendantReady} />,
            document.body,
          )}
    </section>
  );
}

function ResolvedReady({ children }: { children: ReactNode }) {
  usePaneResolvedBodyReady();
  return children;
}

function RouteContents({
  ready,
  descendantReady,
  heading,
  rows,
  anchorKind,
}: {
  ready: boolean;
  descendantReady: boolean | null;
  heading: boolean;
  rows: readonly { readonly id: string; readonly top: number }[] | undefined;
  anchorKind: "collection" | "note";
}) {
  return (
    <>
      <BodyReady ready={ready} />
      {descendantReady === null ? null : (
        <DescendantReady ready={descendantReady} />
      )}
      {heading ? (
        <h1 data-pane-return-heading tabIndex={-1}>
          Route heading
        </h1>
      ) : null}
      {rows ? (
        <div
          data-pane-return-scope={
            anchorKind === "note"
              ? "Notes.EditorBlocks"
              : "Library.Results"
          }
        >
          {rows.map((row) => (
            <div
              key={row.id}
              data-testid={`row-${row.id}`}
              {...(anchorKind === "note"
                ? { "data-note-block-id": row.id }
                : { "data-collection-row-id": row.id })}
              data-mock-top={row.top}
            >
              <button data-row-focusable type="button">
                {row.id}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div>Unanchored content</div>
      )}
    </>
  );
}

function BodyReady({ ready }: { ready: boolean }) {
  usePaneReturnReady(ready);
  return null;
}

function DescendantReady({ ready }: { ready: boolean }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  usePaneReturnDescendantReady({ rootRef, ready });
  return <span ref={rootRef} />;
}

function RouteScope({
  visitId,
  children,
}: {
  visitId: PaneVisitId;
  children: ReactNode;
}) {
  return (
    <PaneReturnVisitScope visitId={visitId} routeKey={ROUTE_KEY}>
      {children}
    </PaneReturnVisitScope>
  );
}

function ScrollFixture({
  visitId,
  ready = true,
  contentHeight = 400,
  rows,
  anchorKind,
  resolved,
  descendantReady,
  portalDescendantReady,
  heading,
  publish,
}: {
  visitId: PaneVisitId;
  ready?: boolean;
  contentHeight?: number;
  rows?: readonly { readonly id: string; readonly top: number }[];
  anchorKind?: "collection" | "note";
  resolved?: boolean;
  descendantReady?: boolean | null;
  portalDescendantReady?: boolean | null;
  heading?: boolean;
  publish: (commands: PaneReturnMementoCommands) => void;
}) {
  return (
    <PaneReturnMementoProvider>
      <CommandsProbe publish={publish} />
      <RouteScope visitId={visitId}>
        <ScrollRoute
          paneId="pane-1"
          visitId={visitId}
          ready={ready}
          contentHeight={contentHeight}
          rows={rows}
          anchorKind={anchorKind}
          resolved={resolved}
          descendantReady={descendantReady}
          portalDescendantReady={portalDescendantReady}
          heading={heading}
        />
      </RouteScope>
    </PaneReturnMementoProvider>
  );
}

function ScrollLifecycleFixture({
  visitId,
  showRoute,
  ready,
  contentHeight,
  publish,
}: {
  visitId: PaneVisitId;
  showRoute: boolean;
  ready: boolean;
  contentHeight: number;
  publish: (commands: PaneReturnMementoCommands) => void;
}) {
  return (
    <PaneReturnMementoProvider>
      <CommandsProbe publish={publish} />
      {showRoute ? (
        <RouteScope visitId={visitId}>
          <ScrollRoute
            paneId="pane-1"
            visitId={visitId}
            ready={ready}
            contentHeight={contentHeight}
          />
        </RouteScope>
      ) : null}
    </PaneReturnMementoProvider>
  );
}

function VisitDataRoute({
  data,
  dataKey = DATA_KEY,
}: {
  data:
    | { readonly page: number }
    | { readonly payload: string }
    | null;
  dataKey?:
    | typeof DATA_KEY
    | typeof OVERSIZED_DATA_KEY;
}) {
  usePaneReturnReady(true);
  const restored = usePaneVisitData(
    dataKey as ReturnType<
      typeof definePaneVisitDataKey<
        { readonly page: number } | { readonly payload: string }
      >
    >,
    () => data,
  );
  const summary =
    restored && "page" in restored
      ? JSON.stringify(restored)
      : restored && "payload" in restored
        ? `payload:${restored.payload.length}`
        : "none";
  return (
    <output data-testid="restored-data">{summary}</output>
  );
}

function VisitDataFixture({
  visitId,
  data,
  dataKey,
  publish,
}: {
  visitId: PaneVisitId;
  data:
    | { readonly page: number }
    | { readonly payload: string }
    | null;
  dataKey?: typeof DATA_KEY | typeof OVERSIZED_DATA_KEY;
  publish: (commands: PaneReturnMementoCommands) => void;
}) {
  return (
    <PaneReturnMementoProvider>
      <CommandsProbe publish={publish} />
      <RouteScope visitId={visitId}>
        <ResolvedReady>
          <VisitDataRoute data={data} dataKey={dataKey} />
        </ResolvedReady>
      </RouteScope>
    </PaneReturnMementoProvider>
  );
}

function MountedVisitDataRoute({
  data,
  outputTestId,
  invalidateLabel,
}: {
  data: { readonly page: number };
  outputTestId: string;
  invalidateLabel: string;
}) {
  usePaneReturnReady(true);
  const restored = usePaneVisitData(DATA_KEY, () => data);
  const clearAllVisitData = useClearAllPaneVisitData();
  return (
    <>
      <output data-testid={outputTestId}>
        {restored ? JSON.stringify(restored) : "none"}
      </output>
      {invalidateLabel ? (
        <button type="button" onClick={clearAllVisitData}>
          {invalidateLabel}
        </button>
      ) : null}
    </>
  );
}

function MountedVisitDataFixture({
  originData,
  peerData,
  originGeneration,
  peerGeneration,
  publish,
}: {
  originData: { readonly page: number };
  peerData: { readonly page: number };
  originGeneration: number;
  peerGeneration: number;
  publish: (commands: PaneReturnMementoCommands) => void;
}) {
  return (
    <PaneReturnMementoProvider>
      <CommandsProbe publish={publish} />
      <RouteScope visitId={VISIT_1}>
        <ResolvedReady>
          <MountedVisitDataRoute
            key={originGeneration}
            data={originData}
            outputTestId="origin-restored-data"
            invalidateLabel="Invalidate from origin"
          />
        </ResolvedReady>
      </RouteScope>
      <RouteScope visitId={VISIT_2}>
        <ResolvedReady>
          <MountedVisitDataRoute
            key={peerGeneration}
            data={peerData}
            outputTestId="peer-restored-data"
            invalidateLabel="Invalidate from peer"
          />
        </ResolvedReady>
      </RouteScope>
    </PaneReturnMementoProvider>
  );
}

function ScrollDataRoute({
  paneId,
  visitId,
  data,
}: {
  paneId: string;
  visitId: PaneVisitId;
  data: { readonly payload: string };
}) {
  const scrollportRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollportRef.current) {
      defineGeometry(scrollportRef.current, 400);
    }
  }, [visitId]);
  usePaneReturnScrollport({
    paneId,
    enabled: true,
    scrollportRef,
  });
  usePaneReturnReady(true);
  const restored = usePaneVisitData(BUDGET_DATA_KEY, () => data);
  return (
    <div ref={scrollportRef} data-testid="scrollport">
      <div key={visitId}>
        <output data-testid="restored-data">
          {restored ? `payload:${restored.payload.length}` : "none"}
        </output>
      </div>
    </div>
  );
}

function ScrollDataFixture({
  paneId = "pane-1",
  visitId,
  data,
  publish,
}: {
  paneId?: string;
  visitId: PaneVisitId;
  data: { readonly payload: string };
  publish: (commands: PaneReturnMementoCommands) => void;
}) {
  return (
    <PaneReturnMementoProvider>
      <CommandsProbe publish={publish} />
      <RouteScope visitId={visitId}>
        <ResolvedReady>
          <ScrollDataRoute paneId={paneId} visitId={visitId} data={data} />
        </ResolvedReady>
      </RouteScope>
    </PaneReturnMementoProvider>
  );
}

describe("PaneReturnMementoProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defects when a resolved ShellScroll body omits route readiness", () => {
    expect(() =>
      render(
        <PaneReturnMementoProvider>
          <RouteScope visitId={VISIT_1}>
            <ResolvedReady>
              <div>Missing body readiness</div>
            </ResolvedReady>
          </RouteScope>
        </PaneReturnMementoProvider>,
      ),
    ).toThrow(
      "Resolved ShellScroll pane body omitted its route readiness token",
    );
  });

  it("requests restoration from the production scrollport registration path", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const view = render(
      <ScrollFixture visitId={VISIT_1} publish={publish} />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 190;
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });
    view.rerender(
      <ScrollFixture visitId={VISIT_2} publish={publish} />,
    );
    view.rerender(
      <ScrollFixture visitId={VISIT_1} publish={publish} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("scrollport").scrollTop).toBe(190),
    );
  });

  it("starts persisted visits at the top after the provider remounts", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const view = render(
      <ScrollFixture visitId={VISIT_1} publish={publish} />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 190;
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });
    view.unmount();

    commands = null;
    render(<ScrollFixture visitId={VISIT_1} publish={publish} />);
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      commands?.requestRestore({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
      });
    });

    expect(screen.getByTestId("scrollport").scrollTop).toBe(0);
  });

  it("restores the eye-line anchor and keyboard focus independently", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const sourceRows = [
      { id: "a", top: 0 },
      { id: "b", top: 80 },
      { id: "c", top: 160 },
    ] as const;
    const view = render(
      <ScrollFixture
        visitId={VISIT_1}
        rows={sourceRows}
        publish={publish}
      />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    const scrollport = screen.getByTestId("scrollport");
    act(() => {
      scrollport.scrollTop = 80;
      screen.getByRole("button", { name: "c" }).focus();
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Keyboard",
      });
    });

    view.rerender(
      <ScrollFixture visitId={VISIT_2} rows={sourceRows} publish={publish} />,
    );
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        rows={[
          { id: "a", top: 0 },
          { id: "c", top: 80 },
          { id: "b", top: 160 },
        ]}
        publish={publish}
      />,
    );
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 0;
      commands?.requestRestore({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("scrollport").scrollTop).toBe(160),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "c" })).toHaveFocus(),
    );
  });

  it("restores a notes editor block anchor through the shell scrollport", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const sourceRows = [
      { id: "block-a", top: 0 },
      { id: "block-b", top: 160 },
    ] as const;
    const view = render(
      <ScrollFixture
        visitId={VISIT_1}
        rows={sourceRows}
        anchorKind="note"
        publish={publish}
      />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 160;
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });

    view.rerender(
      <ScrollFixture
        visitId={VISIT_2}
        rows={sourceRows}
        anchorKind="note"
        publish={publish}
      />,
    );
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        rows={[
          { id: "block-a", top: 0 },
          { id: "block-b", top: 220 },
        ]}
        anchorKind="note"
        publish={publish}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("scrollport").scrollTop).toBe(220),
    );
  });

  it("clamps raw position after a captured notes block disappears", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const sourceRows = [
      { id: "block-a", top: 0 },
      { id: "block-b", top: 240 },
    ] as const;
    const targetRows = [{ id: "block-a", top: 0 }] as const;
    const view = render(
      <ScrollFixture
        visitId={VISIT_1}
        rows={sourceRows}
        anchorKind="note"
        publish={publish}
      />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 240;
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });

    view.rerender(
      <ScrollFixture
        visitId={VISIT_2}
        rows={sourceRows}
        anchorKind="note"
        publish={publish}
      />,
    );
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        ready={false}
        contentHeight={140}
        rows={targetRows}
        anchorKind="note"
        publish={publish}
      />,
    );
    expect(screen.getByTestId("scrollport").scrollTop).toBe(0);

    view.rerender(
        <ScrollFixture
          visitId={VISIT_1}
          contentHeight={140}
          rows={targetRows}
          anchorKind="note"
          publish={publish}
        />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("scrollport").scrollTop).toBe(40),
    );
  });

  it("reapplies a ready semantic anchor after the first committed frame", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const rows = [
      { id: "a", top: 0 },
      { id: "b", top: 80 },
    ] as const;
    const view = render(
      <ScrollFixture visitId={VISIT_1} rows={rows} publish={publish} />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 80;
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });

    view.rerender(
      <ScrollFixture visitId={VISIT_2} rows={rows} publish={publish} />,
    );
    view.rerender(
      <ScrollFixture visitId={VISIT_1} rows={rows} publish={publish} />,
    );
    await waitFor(() => expect(frames).toHaveLength(1));
    act(() => {
      frames[0]!(0);
    });
    expect(frames).toHaveLength(2);
    screen.getByTestId("row-b").dataset.mockTop = "88";
    act(() => {
      frames[1]!(16);
    });

    expect(screen.getByTestId("scrollport").scrollTop).toBe(88);
  });

  it("degrades missing keyboard focus to route heading and then pane chrome", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const sourceRows = [
      { id: "a", top: 0 },
      { id: "b", top: 80 },
      { id: "c", top: 160 },
    ] as const;
    const targetRows = sourceRows.slice(0, 2);
    const view = render(
      <ScrollFixture
        visitId={VISIT_1}
        rows={sourceRows}
        publish={publish}
      />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 80;
      screen.getByRole("button", { name: "c" }).focus();
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Keyboard",
      });
    });
    view.rerender(
      <ScrollFixture
        visitId={VISIT_2}
        rows={sourceRows}
        publish={publish}
      />,
    );
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        rows={targetRows}
        heading
        publish={publish}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Route heading" }),
      ).toHaveFocus(),
    );

    view.rerender(
      <ScrollFixture
        visitId={VISIT_2}
        rows={sourceRows}
        publish={publish}
      />,
    );
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        rows={targetRows}
        publish={publish}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pane chrome" })).toHaveFocus(),
    );
  });

  it("does not move focus for pointer journeys", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const rows = [
      { id: "a", top: 0 },
      { id: "b", top: 80 },
    ] as const;
    const view = render(
      <ScrollFixture visitId={VISIT_1} rows={rows} publish={publish} />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 80;
      screen.getByRole("button", { name: "b" }).focus();
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Pointer",
      });
    });
    view.rerender(
      <ScrollFixture visitId={VISIT_2} rows={rows} publish={publish} />,
    );
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        rows={[{ id: "a", top: 0 }]}
        heading
        publish={publish}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Route heading" }),
    ).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Pane chrome" })).not.toHaveFocus();
  });

  it("waits for resolved body, route body, and descendant readiness before focus completion", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const rows = [
      { id: "a", top: 0 },
      { id: "b", top: 80 },
    ] as const;
    const view = render(
      <ScrollFixture visitId={VISIT_1} rows={rows} publish={publish} />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 80;
      screen.getByRole("button", { name: "b" }).focus();
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Keyboard",
      });
    });
    view.rerender(
      <ScrollFixture visitId={VISIT_2} rows={rows} publish={publish} />,
    );
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        rows={rows}
        resolved={false}
        ready={false}
        descendantReady={false}
        publish={publish}
      />,
    );
    act(() => {
      commands?.requestRestore({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
      });
    });
    expect(screen.getByTestId("scrollport").scrollTop).toBe(80);
    expect(screen.getByRole("button", { name: "b" })).not.toHaveFocus();

    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        rows={rows}
        ready={false}
        descendantReady={false}
        publish={publish}
      />,
    );
    expect(screen.getByRole("button", { name: "b" })).not.toHaveFocus();
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        rows={rows}
        descendantReady={false}
        publish={publish}
      />,
    );
    expect(screen.getByRole("button", { name: "b" })).not.toHaveFocus();
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        rows={rows}
        descendantReady
        publish={publish}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "b" })).toHaveFocus(),
    );
  });

  it("waits for route readiness before degrading unanchored keyboard focus", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const view = render(
      <ScrollFixture
        visitId={VISIT_1}
        heading
        publish={publish}
      />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 80;
      screen.getByRole("heading", { name: "Route heading" }).focus();
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Keyboard",
      });
    });

    view.rerender(
      <ScrollFixture visitId={VISIT_2} publish={publish} />,
    );
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        ready={false}
        publish={publish}
      />,
    );

    expect(screen.getByTestId("scrollport").scrollTop).toBe(80);
    expect(
      screen.getByRole("button", { name: "Pane chrome" }),
    ).not.toHaveFocus();

    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        heading
        publish={publish}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Route heading" }),
      ).toHaveFocus(),
    );
  });

  it("ignores descendant readiness registered from a portal outside pane content", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const rows = [
      { id: "a", top: 0 },
      { id: "b", top: 80 },
    ] as const;
    const view = render(
      <ScrollFixture visitId={VISIT_1} rows={rows} publish={publish} />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 80;
      screen.getByRole("button", { name: "b" }).focus();
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Keyboard",
      });
    });
    view.rerender(
      <ScrollFixture
        visitId={VISIT_2}
        rows={rows}
        portalDescendantReady={false}
        publish={publish}
      />,
    );
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        rows={rows}
        portalDescendantReady={false}
        publish={publish}
      />,
    );
    act(() => {
      commands?.requestRestore({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
      });
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "b" })).toHaveFocus(),
    );
  });

  it("performs one final raw clamp after route readiness", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const view = render(
      <ScrollFixture visitId={VISIT_1} publish={publish} />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 240;
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });
    view.rerender(
      <ScrollFixture visitId={VISIT_2} publish={publish} />,
    );
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        ready={false}
        contentHeight={140}
        publish={publish}
      />,
    );
    act(() => {
      commands?.requestRestore({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
      });
    });
    expect(screen.getByTestId("scrollport").scrollTop).toBe(0);
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        contentHeight={140}
        publish={publish}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("scrollport").scrollTop).toBe(40),
    );
  });

  it("cancels a pending raw restore on user scrolling intent", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const view = render(
      <ScrollFixture visitId={VISIT_1} publish={publish} />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 240;
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Pointer",
      });
    });
    view.rerender(
      <ScrollFixture visitId={VISIT_2} publish={publish} />,
    );
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        ready={false}
        contentHeight={100}
        publish={publish}
      />,
    );
    act(() => {
      commands?.requestRestore({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
      });
    });
    fireEvent.wheel(screen.getByTestId("scrollport"));
    view.rerender(
      <ScrollFixture
        visitId={VISIT_1}
        contentHeight={400}
        publish={publish}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("scrollport").scrollTop).toBe(0),
    );
  });

  it("captures and restores route-owned data only for the exact visit", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const view = render(
      <VisitDataFixture
        visitId={VISIT_1}
        data={{ page: 7 }}
        publish={publish}
      />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });
    view.rerender(
      <VisitDataFixture
        visitId={VISIT_2}
        data={{ page: 1 }}
        publish={publish}
      />,
    );
    expect(screen.getByTestId("restored-data")).toHaveTextContent("none");
    view.rerender(
      <VisitDataFixture
        visitId={VISIT_1}
        data={{ page: 1 }}
        publish={publish}
      />,
    );
    expect(screen.getByTestId("restored-data")).toHaveTextContent('"page":7');
  });

  it("blocks a stale mounted peer until its own invalidation makes fresh truth capturable", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    let originData = { page: 1 };
    let peerData = { page: 2 };
    let originGeneration = 0;
    const peerGeneration = 0;
    const fixture = () => (
      <MountedVisitDataFixture
        originData={originData}
        peerData={peerData}
        originGeneration={originGeneration}
        peerGeneration={peerGeneration}
        publish={publish}
      />
    );
    const view = render(fixture());
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      commands?.capturePane({
        paneId: "pane-origin",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
      commands?.capturePane({
        paneId: "pane-peer",
        visitId: VISIT_2,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });

    originData = { page: 10 };
    view.rerender(fixture());
    fireEvent.click(
      screen.getByRole("button", { name: "Invalidate from origin" }),
    );
    act(() => {
      commands?.capturePane({
        paneId: "pane-peer",
        visitId: VISIT_2,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
      commands?.capturePane({
        paneId: "pane-origin",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });

    view.rerender(fixture());

    expect(screen.getByTestId("origin-restored-data")).toHaveTextContent(
      '"page":10',
    );
    expect(screen.getByTestId("peer-restored-data")).toHaveTextContent("none");

    peerData = { page: 20 };
    view.rerender(fixture());
    fireEvent.click(
      screen.getByRole("button", { name: "Invalidate from peer" }),
    );
    act(() => {
      commands?.capturePane({
        paneId: "pane-origin",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
      commands?.capturePane({
        paneId: "pane-peer",
        visitId: VISIT_2,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });
    view.rerender(fixture());

    expect(screen.getByTestId("origin-restored-data")).toHaveTextContent("none");
    expect(screen.getByTestId("peer-restored-data")).toHaveTextContent(
      '"page":20',
    );

    originData = { page: 30 };
    originGeneration += 1;
    view.rerender(fixture());
    act(() => {
      commands?.capturePane({
        paneId: "pane-origin",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });
    view.rerender(fixture());

    expect(screen.getByTestId("origin-restored-data")).toHaveTextContent(
      '"page":30',
    );
  });

  it("stores no extent when route data has not committed", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const view = render(
      <VisitDataFixture
        visitId={VISIT_1}
        data={null}
        publish={publish}
      />,
    );
    await waitFor(() => expect(commands).not.toBeNull());

    expect(() => {
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    }).not.toThrow();

    view.rerender(
      <VisitDataFixture
        visitId={VISIT_2}
        data={{ page: 1 }}
        publish={publish}
      />,
    );
    view.rerender(
      <VisitDataFixture
        visitId={VISIT_1}
        data={{ page: 1 }}
        publish={publish}
      />,
    );
    expect(screen.getByTestId("restored-data")).toHaveTextContent("none");
  });

  it("rejects a route-owned snapshot over the per-visit byte budget", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const oversized = { payload: "x".repeat(2 * 1024 * 1024) };
    const view = render(
      <VisitDataFixture
        visitId={VISIT_1}
        data={oversized}
        dataKey={OVERSIZED_DATA_KEY}
        publish={publish}
      />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });
    view.rerender(
      <VisitDataFixture
        visitId={VISIT_2}
        data={{ payload: "new" }}
        dataKey={OVERSIZED_DATA_KEY}
        publish={publish}
      />,
    );
    view.rerender(
      <VisitDataFixture
        visitId={VISIT_1}
        data={{ payload: "new" }}
        dataKey={OVERSIZED_DATA_KEY}
        publish={publish}
      />,
    );

    expect(screen.getByTestId("restored-data")).toHaveTextContent("none");
  });

  it("keeps the newest scrollport, capture getter, and readiness registrations through Strict Mode replay", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const renderStrict = (
      visitId: PaneVisitId,
      data: { readonly payload: string },
    ) => (
      <StrictMode>
        <ScrollDataFixture
          visitId={visitId}
          data={data}
          publish={publish}
        />
      </StrictMode>
    );
    const view = render(renderStrict(VISIT_1, { payload: "captured" }));
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 175;
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });
    view.rerender(renderStrict(VISIT_2, { payload: "other" }));
    view.rerender(renderStrict(VISIT_1, { payload: "fresh" }));
    act(() => {
      commands?.requestRestore({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("scrollport").scrollTop).toBe(175),
    );
    expect(screen.getByTestId("restored-data")).toHaveTextContent(
      "payload:8",
    );
  });

  it("terminates a pending restore when its registered scrollport unmounts", async () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {
          disconnect();
        }
      },
    );
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const view = render(
      <ScrollLifecycleFixture
        visitId={VISIT_1}
        showRoute
        ready
        contentHeight={400}
        publish={publish}
      />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      screen.getByTestId("scrollport").scrollTop = 200;
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });
    view.rerender(
      <ScrollLifecycleFixture
        visitId={VISIT_1}
        showRoute
        ready={false}
        contentHeight={100}
        publish={publish}
      />,
    );
    act(() => {
      commands?.requestRestore({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
      });
    });
    const disconnectsBeforeUnmount = disconnect.mock.calls.length;
    view.rerender(
      <ScrollLifecycleFixture
        visitId={VISIT_1}
        showRoute={false}
        ready={false}
        contentHeight={100}
        publish={publish}
      />,
    );
    expect(disconnect).toHaveBeenCalledTimes(disconnectsBeforeUnmount + 1);
  });

  it("evicts global visit data deterministically while retaining mementos", async () => {
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const visits = Array.from({ length: 19 }, (_, index) =>
      assumePaneVisitId(
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      ),
    );
    const data = { payload: "x".repeat(900 * 1024) };
    const view = render(
      <ScrollDataFixture
        visitId={visits[0]}
        data={data}
        publish={publish}
      />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      commands?.reconcileVisitTopology({
        activePaneId: "pane-1",
        panes: [
          {
            paneId: "pane-1",
            currentVisitId: visits[18],
            backVisitIds: visits.slice(0, 18),
            forwardVisitIds: [],
          },
        ],
      });
    });
    for (const [index, visitId] of visits.entries()) {
      if (index > 0) {
        view.rerender(
          <ScrollDataFixture
            visitId={visitId}
            data={data}
            publish={publish}
          />,
        );
      }
      act(() => {
        if (index === 0) {
          screen.getByTestId("scrollport").scrollTop = 180;
        }
        commands?.capturePane({
          paneId: "pane-1",
          visitId,
          routeKey: ROUTE_KEY,
          modality: "Programmatic",
        });
      });
    }

    view.rerender(
      <ScrollDataFixture
        visitId={visits[0]}
        data={{ payload: "fresh" }}
        publish={publish}
      />,
    );
    expect(screen.getByTestId("restored-data")).toHaveTextContent("none");
    act(() => {
      commands?.requestRestore({
        paneId: "pane-1",
        visitId: visits[0],
        routeKey: ROUTE_KEY,
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("scrollport").scrollTop).toBe(180),
    );
    view.rerender(
      <ScrollDataFixture
        visitId={visits[1]}
        data={{ payload: "fresh" }}
        publish={publish}
      />,
    );
    expect(screen.getByTestId("restored-data")).toHaveTextContent(
      `payload:${data.payload.length}`,
    );
  });

  it("keeps equal diagnostic key names and neighboring visits isolated", async () => {
    const duplicateNameA = definePaneVisitDataKey<{ readonly page: number }>(
      "Library.DuplicateName",
    );
    const duplicateNameB = definePaneVisitDataKey<{ readonly page: number }>(
      "Library.DuplicateName",
    );
    let commands: PaneReturnMementoCommands | null = null;
    const publish = (next: PaneReturnMementoCommands) => {
      commands = next;
    };
    const view = render(
      <VisitDataFixture
        visitId={VISIT_1}
        data={{ page: 9 }}
        dataKey={duplicateNameA}
        publish={publish}
      />,
    );
    await waitFor(() => expect(commands).not.toBeNull());
    act(() => {
      commands?.capturePane({
        paneId: "pane-1",
        visitId: VISIT_1,
        routeKey: ROUTE_KEY,
        modality: "Programmatic",
      });
    });
    view.rerender(
      <VisitDataFixture
        visitId={VISIT_2}
        data={{ page: 2 }}
        dataKey={duplicateNameA}
        publish={publish}
      />,
    );
    expect(screen.getByTestId("restored-data")).toHaveTextContent("none");
    view.rerender(
      <VisitDataFixture
        visitId={VISIT_1}
        data={{ page: 1 }}
        dataKey={duplicateNameB}
        publish={publish}
      />,
    );
    expect(screen.getByTestId("restored-data")).toHaveTextContent("none");
  });
});
