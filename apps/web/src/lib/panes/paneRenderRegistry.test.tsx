import {
  Suspense,
  lazy,
  useLayoutEffect,
  useRef,
  type ComponentType,
  type ReactNode,
} from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
  usePaneReturnMementoCommands,
  usePaneReturnReady,
  usePaneReturnScrollport,
} from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId, type PaneVisitId } from "@/lib/workspace/schema";
import { ResolvedPaneBodyMarker } from "./paneRenderRegistry";

const VISIT_1 = assumePaneVisitId("11111111-1111-4111-8111-111111111111");
const VISIT_2 = assumePaneVisitId("22222222-2222-4222-8222-222222222222");
const ROUTE_KEY = "settings:/settings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function defineGeometry(scrollport: HTMLElement, contentHeight: number): void {
  let scrollTop = 0;
  Object.defineProperties(scrollport, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: contentHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
  });
}

function ReadyBody({ label }: { readonly label: string }) {
  usePaneReturnReady(true);
  return <div>{label}</div>;
}

function PaneFixture({
  visitId,
  contentHeight,
  body,
}: {
  readonly visitId: PaneVisitId;
  readonly contentHeight: number;
  readonly body: ReactNode;
}) {
  const scrollportRef = useRef<HTMLDivElement>(null);
  const commands = usePaneReturnMementoCommands();
  useLayoutEffect(() => {
    if (scrollportRef.current) {
      defineGeometry(scrollportRef.current, contentHeight);
    }
  }, [contentHeight, visitId]);
  usePaneReturnScrollport({
    paneId: "pane-1",
    enabled: true,
    scrollportRef,
  });
  return (
    <>
      <button
        type="button"
        onClick={() => {
          commands.capturePane({
            paneId: "pane-1",
            visitId,
            routeKey: ROUTE_KEY,
            modality: "Programmatic",
          });
        }}
      >
        Capture pane
      </button>
      <div ref={scrollportRef} data-testid="scrollport">
        <div>{body}</div>
      </div>
    </>
  );
}

function TestApp({
  visitId,
  contentHeight,
  body,
}: {
  readonly visitId: PaneVisitId;
  readonly contentHeight: number;
  readonly body: ReactNode;
}) {
  return (
    <PaneReturnMementoProvider>
      <PaneReturnVisitScope visitId={visitId} routeKey={ROUTE_KEY}>
        <PaneFixture
          visitId={visitId}
          contentHeight={contentHeight}
          body={body}
        />
      </PaneReturnVisitScope>
    </PaneReturnMementoProvider>
  );
}

describe("ResolvedPaneBodyMarker", () => {
  it("waits for a suspended pane body to commit before the final return clamp", async () => {
    const paneModule = deferred<{ default: ComponentType }>();
    const DeferredBody = lazy(() => paneModule.promise);
    const readyBody = (label: string) => (
      <ResolvedPaneBodyMarker>
        <ReadyBody label={label} />
      </ResolvedPaneBodyMarker>
    );
    const view = render(
      <TestApp
        visitId={VISIT_1}
        contentHeight={400}
        body={readyBody("First pane")}
      />,
    );

    screen.getByTestId("scrollport").scrollTop = 240;
    fireEvent.click(screen.getByRole("button", { name: "Capture pane" }));
    view.rerender(
      <TestApp
        visitId={VISIT_2}
        contentHeight={400}
        body={readyBody("Second pane")}
      />,
    );
    view.rerender(
      <TestApp
        visitId={VISIT_1}
        contentHeight={140}
        body={
          <Suspense fallback={<div>Loading deferred pane…</div>}>
            <ResolvedPaneBodyMarker>
              <DeferredBody />
            </ResolvedPaneBodyMarker>
          </Suspense>
        }
      />,
    );

    expect(screen.getByText("Loading deferred pane…")).toBeVisible();
    expect(screen.getByTestId("scrollport").scrollTop).toBe(0);

    paneModule.resolve({
      default: () => <ReadyBody label="Deferred pane" />,
    });

    expect(await screen.findByText("Deferred pane")).toBeVisible();
    await waitFor(() => {
      expect(screen.getByTestId("scrollport").scrollTop).toBe(40);
    });
  });
});
