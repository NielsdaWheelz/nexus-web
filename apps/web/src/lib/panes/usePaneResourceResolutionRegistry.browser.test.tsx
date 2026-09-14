import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { page } from "vitest/browser";

import AppNav from "@/components/appnav/AppNav";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { ArtworkProvider } from "@/lib/media/ArtworkProvider";
import { ARTWORK_CAPACITY } from "@/lib/media/artworkCapacity";
import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { OfflineReadingProvider } from "@/lib/offlineReading/OfflineReadingProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ResourceOverlaysProvider } from "@/lib/resources/resourceOverlaysController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import {
  createEmptyPaneHistory,
  createPaneVisit,
  createWorkspaceStateFromPrimaryPanes,
} from "@/lib/workspace/schema";
import { WorkspaceStoreProvider, useWorkspaceStore } from "@/lib/workspace/store";
import { isApiError } from "@/lib/api/client";
import type { PaneResourceLocator } from "./paneResourceLocator";
import { paneResourceLocatorKey } from "./paneResourceLocator";
import { usePaneResourceResolutionRegistry } from "./usePaneResourceResolutionRegistry";

const PAGE_A = "11111111-1111-4111-8111-111111111111";
const PAGE_B = "22222222-2222-4222-8222-222222222222";
const CONTRIBUTOR_IDS: Record<string, string> = {
  "healthy-author": "33333333-3333-4333-8333-333333333333",
  "malformed-author": "44444444-4444-4444-8444-444444444444",
};
const ACCOUNT = "55555555-5555-4555-8555-555555555555";

function locator(id: string): PaneResourceLocator {
  return { kind: "resource_ref", ref: `page:${id}` };
}

function authorLocator(handle: string): PaneResourceLocator {
  return { kind: "contributor_handle", handle };
}

function resourceItem(input: {
  scheme: string;
  id: string;
  route: string | null;
  label: string;
}) {
  const ref = `${input.scheme}:${input.id}`;
  const missing = input.route === null;
  return {
    ref,
    scheme: input.scheme,
    id: input.id,
    label: input.label,
    summary: "",
    route: input.route,
    activation: {
      resourceRef: ref,
      kind: missing ? "none" : "route",
      href: input.route,
      unresolvedReason: missing ? "missing" : null,
    },
    missing,
    capabilities: {
      userRelation: {
        userLinkSource: false,
        userLinkTarget: "none",
        noteReferenceTarget: false,
      },
      sharing: "None",
      libraryPlacement: "None",
      attachable: false,
      chatSubject: "none",
      readable: "none",
      inspectable: "none",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: false,
      promptRender: "none",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: {},
  };
}

function responseRow(candidate: PaneResourceLocator, missing = false) {
  if (candidate.kind === "contributor_handle") {
    const route = `/authors/${candidate.handle}`;
    const item = resourceItem({
      scheme: "contributor",
      id: CONTRIBUTOR_IDS[candidate.handle]!,
      route,
      label: candidate.handle,
    });
    return { locator: candidate, resourceItem: item, canonicalHref: route, documentReader: false };
  }
  const id = candidate.ref.slice("page:".length);
  const item = resourceItem({
    scheme: "page",
    id,
    route: missing ? null : `/pages/${id}`,
    label: missing ? "(resource unavailable)" : `Page ${id}`,
  });
  return { locator: candidate, resourceItem: item, canonicalHref: item.route, documentReader: false };
}

function locatorMap(...locators: PaneResourceLocator[]) {
  return new Map(
    locators.map((candidate) => {
      const key = paneResourceLocatorKey(candidate);
      if (key === null) throw new Error("A concrete locator must have a key");
      return [key, candidate] as const;
    }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function Harness({
  locators,
}: {
  readonly locators: ReadonlyMap<string, PaneResourceLocator>;
}) {
  const registry = usePaneResourceResolutionRegistry(locators);
  const rows = [...locators.keys()].map((key) => {
    const state = registry.statesByKey.get(key);
    const label =
      state?.kind === "Resolved" || state?.kind === "Failed"
        ? `${state.kind}:${state.status}`
        : state?.kind === "Defected"
          ? `Defected:${isApiError(state.cause) ? state.cause.code : "unknown"}`
          : (state?.kind ?? "Pending");
    return <li key={key}>{`${key}=${label}`}</li>;
  });
  const firstFailedKey = [...locators.keys()].find(
    (key) => registry.statesByKey.get(key)?.kind === "Failed",
  );
  return (
    <main>
      <ul>{rows}</ul>
      {firstFailedKey ? (
        <button type="button" onClick={() => registry.retry(firstFailedKey)}>
          Retry
        </button>
      ) : null}
    </main>
  );
}

class DefectBoundary extends Component<
  { children: ReactNode },
  { defect: boolean }
> {
  state = { defect: false };

  static getDerivedStateFromError(): { defect: boolean } {
    return { defect: true };
  }

  render() {
    return this.state.defect ? <p>registry-defect</p> : this.props.children;
  }
}

/** Opens and closes the second pane the way a workspace target activation does,
 *  so the malformed resource arrives in its own batch after the first settles. */
function WorkspaceProbe({ href }: { readonly href: string }) {
  const { state, activateWorkspaceTarget, closePane } = useWorkspaceStore();
  const secondPaneId =
    state.primaryPaneOrder.find((paneId) => paneId !== "healthy") ?? null;
  return (
    <>
      <button
        type="button"
        onClick={() =>
          activateWorkspaceTarget({
            originPaneId: "healthy",
            target: { href },
            disposition: { kind: "Fork" },
            modality: "Pointer",
          })
        }
      >
        Open second pane
      </button>
      {secondPaneId ? (
        <button type="button" onClick={() => closePane(secondPaneId)}>
          Close second pane
        </button>
      ) : null}
      <p data-testid="second-pane-id">{secondPaneId ?? ""}</p>
    </>
  );
}

/** Two panes are visible side by side only on the desktop layout; the mobile
 *  layout renders the active pane alone and cannot witness a sibling. */
async function renderWorkspace(href: string) {
  await page.viewport(1440, 900);
  return render(
    withRenderEnvironment(
      <AuthenticatedAccountProvider
        account={{ accountId: ACCOUNT, calendarTimeZone: "UTC" }}
      >
        <ResourceCacheProvider
          value={{}}
          publicationLimits={READER_CAPACITY.cache}
        >
        <ArtworkProvider limits={ARTWORK_CAPACITY}>
        <KeybindingsProvider>
          <FeedbackProvider>
            <PaneReturnMementoProvider>
              <WorkspaceStoreProvider
                initialState={createWorkspaceStateFromPrimaryPanes({
                  activePrimaryPaneId: "healthy",
                  primaryPanes: [
                    {
                      id: "healthy",
                      currentVisit: createPaneVisit("/authors/healthy-author"),
                      primaryWidthPx: 684,
                      visibility: "visible",
                      history: createEmptyPaneHistory(),
                      attachedSecondaryPaneId: null,
                    },
                  ],
                })}
                workspacePrimaryMetrics={{
                  primaryMinWidthPx: 684,
                  primaryDefaultWidthPx: 684,
                }}
              >
                <MobileChromeProvider>
                  <ShareControllerProvider>
                    <LibraryPlacementControllerProvider>
                      <LecternProvider>
                        <OfflineReadingProvider accountId={ACCOUNT}>
                          <OfflineMediaProvider accountId={ACCOUNT}>
                            <ResourceOverlaysProvider>
                              <GlobalPlayerProvider accountId={ACCOUNT}>
                                <ResourceActionRuntimeProvider>
                                  <ImportsProvider>
                                    <WorkspaceProbe href={href} />
                                    <AppNav />
                                    <div style={{ height: 800, width: 1400 }}>
                                      <WorkspaceHost />
                                    </div>
                                  </ImportsProvider>
                                </ResourceActionRuntimeProvider>
                              </GlobalPlayerProvider>
                            </ResourceOverlaysProvider>
                          </OfflineMediaProvider>
                        </OfflineReadingProvider>
                      </LecternProvider>
                    </LibraryPlacementControllerProvider>
                  </ShareControllerProvider>
                </MobileChromeProvider>
              </WorkspaceStoreProvider>
            </PaneReturnMementoProvider>
          </FeedbackProvider>
        </KeybindingsProvider>
        </ArtworkProvider>
        </ResourceCacheProvider>
      </AuthenticatedAccountProvider>,
    ),
  );
}

/** The workspace's only answered endpoint is locator resolution; every other
 *  pane read fails as a modeled 404 so no other boundary can be disturbed. */
function stubWorkspaceFetch(
  resolveLocators: (locators: PaneResourceLocator[]) => Promise<Response>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.origin,
      );
      if (url.pathname === "/api/resource-items/locators/resolve") {
        return resolveLocators(JSON.parse(String(init?.body)).locators);
      }
      return Response.json(
        { error: { code: "E_NOT_FOUND", message: "Absent in this proof" } },
        { status: 404 },
      );
    }),
  );
}

const originalSendBeacon = navigator.sendBeacon;

function captureDefectBeacons(): Blob[] {
  const beacons: Blob[] = [];
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (_url: string, body: unknown) => {
      if (body instanceof Blob) beacons.push(body);
      return true;
    },
  });
  return beacons;
}

function paneBoundaryFailure(paneId: string) {
  return within(screen.getByTestId(`pane-error-boundary-${paneId}`)).queryByRole(
    "heading",
    { name: "This pane couldn’t load" },
  );
}

function secondPaneId(): string {
  const published = screen.getByTestId("second-pane-id").textContent ?? "";
  if (!published) throw new Error("Expected the workspace to hold two panes");
  return published;
}

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: originalSendBeacon,
  });
});

describe("pane resource resolution registry in Chromium", () => {
  it("batches live identities and publishes closed ready/missing states", async () => {
    const requests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body.locators);
        return Response.json({
          data: {
            resolutions: body.locators.map(
              (candidate: PaneResourceLocator, index: number) =>
                responseRow(candidate, index === 1),
            ),
          },
        });
      }),
    );

    render(<Harness locators={locatorMap(locator(PAGE_A), locator(PAGE_B))} />);

    expect(
      await screen.findByText(/resource_ref:page:1111.*Resolved:ready/),
    ).toBeVisible();
    expect(
      screen.getByText(/resource_ref:page:2222.*Resolved:missing/),
    ).toBeVisible();
    expect(requests).toEqual([[locator(PAGE_A), locator(PAGE_B)]]);
  });

  it("aborts and discards an in-flight batch once its locator leaves the live set", async () => {
    const request = deferred<Response>();
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        return request.promise;
      }),
    );
    const { rerender } = render(
      <Harness locators={locatorMap(locator(PAGE_A))} />,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    rerender(<Harness locators={locatorMap()} />);
    expect(signals[0]?.aborted).toBe(true);
    request.resolve(
      Response.json({ data: { resolutions: [responseRow(locator(PAGE_A))] } }),
    );

    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
  });

  it("keeps an operational failure explicit and retries the same identity", async () => {
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? Response.json(
              { error: { code: "E_UPSTREAM", message: "Try again" } },
              { status: 503 },
            )
          : Response.json({
              data: { resolutions: [responseRow(locator(PAGE_A))] },
            });
      }),
    );

    render(<Harness locators={locatorMap(locator(PAGE_A))} />);
    expect(await screen.findByText(/Failed:error/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/Resolved:ready/)).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("holds a malformed same-system response against only the locators of its own batch", async () => {
    const settled = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const locators = JSON.parse(String(init?.body))
          .locators as PaneResourceLocator[];
        if (
          locators.some(
            (candidate) =>
              candidate.kind === "resource_ref" &&
              candidate.ref === `page:${PAGE_B}`,
          )
        ) {
          // A row count that disagrees with the request is a decoder defect.
          return Response.json({ data: { resolutions: [] } });
        }
        return settled.promise;
      }),
    );
    const { rerender } = render(
      <DefectBoundary>
        <Harness locators={locatorMap(locator(PAGE_A))} />
      </DefectBoundary>,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    settled.resolve(
      Response.json({ data: { resolutions: [responseRow(locator(PAGE_A))] } }),
    );
    expect(await screen.findByText(/page:1111.*Resolved:ready/)).toBeVisible();

    rerender(
      <DefectBoundary>
        <Harness locators={locatorMap(locator(PAGE_A), locator(PAGE_B))} />
      </DefectBoundary>,
    );

    expect(
      await screen.findByText(/page:2222.*Defected:E_INVALID_RESPONSE/),
    ).toBeVisible();
    expect(screen.getByText(/page:1111.*Resolved:ready/)).toBeVisible();
    expect(screen.queryByText("registry-defect")).toBeNull();
  });

  it("contains a malformed pane resource inside that pane's boundary, leaving its sibling pane and the app nav mounted", async () => {
    const beacons = captureDefectBeacons();
    const batches: PaneResourceLocator[][] = [];
    stubWorkspaceFetch(async (locators) => {
      batches.push(locators);
      return locators.some(
        (candidate) =>
          candidate.kind === "contributor_handle" &&
          candidate.handle === "malformed-author",
      )
        ? Response.json({ data: { resolutions: [] } })
        : Response.json({
            data: { resolutions: locators.map((c) => responseRow(c)) },
          });
    });

    await renderWorkspace("/authors/malformed-author");
    await waitFor(() =>
      expect(batches).toEqual([[authorLocator("healthy-author")]]),
    );
    const healthyPane = await screen.findByTestId(
      "pane-error-boundary-healthy",
    );
    const nav = screen.getByRole("navigation", { name: "Primary" });

    await userEvent.click(
      screen.getByRole("button", { name: "Open second pane" }),
    );
    await waitFor(() => expect(batches).toHaveLength(2));
    expect(batches[1]).toEqual([authorLocator("malformed-author")]);

    const defectPaneId = secondPaneId();
    await waitFor(() => expect(paneBoundaryFailure(defectPaneId)).toBeVisible());
    expect(paneBoundaryFailure("healthy")).toBeNull();
    expect(screen.getByTestId("pane-error-boundary-healthy")).toBe(healthyPane);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBe(nav);
    expect(JSON.parse(await beacons[0]!.text())).toMatchObject({
      scope: "Pane",
      pane_id: defectPaneId,
      phase: "Render",
      error_code: "E_INVALID_RESPONSE",
    });
  });

  it("ignores a malformed resolution that arrives after its pane closed", async () => {
    const beacons = captureDefectBeacons();
    const late = deferred<Response>();
    const batches: PaneResourceLocator[][] = [];
    stubWorkspaceFetch(async (locators) => {
      batches.push(locators);
      const malformed = locators.some(
        (candidate) =>
          candidate.kind === "contributor_handle" &&
          candidate.handle === "malformed-author",
      );
      if (malformed && batches.length === 2) return late.promise;
      return Response.json({
        data: { resolutions: locators.map((c) => responseRow(c)) },
      });
    });

    await renderWorkspace("/authors/malformed-author");
    await waitFor(() => expect(batches).toHaveLength(1));
    const healthyPane = await screen.findByTestId(
      "pane-error-boundary-healthy",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Open second pane" }),
    );
    await waitFor(() => expect(batches).toHaveLength(2));
    await userEvent.click(
      screen.getByRole("button", { name: "Close second pane" }),
    );
    late.resolve(Response.json({ data: { resolutions: [] } }));

    // Re-opening the same locator must ask again — and, because the late defect
    // was retired with its pane, it answers as a healthy pane.
    await userEvent.click(
      screen.getByRole("button", { name: "Open second pane" }),
    );
    await waitFor(() => expect(batches).toHaveLength(3));
    const reopenedPaneId = secondPaneId();
    await waitFor(() =>
      expect(
        screen.getByTestId(`pane-error-boundary-${reopenedPaneId}`),
      ).toBeVisible(),
    );
    expect(paneBoundaryFailure(reopenedPaneId)).toBeNull();
    expect(paneBoundaryFailure("healthy")).toBeNull();
    expect(screen.getByTestId("pane-error-boundary-healthy")).toBe(healthyPane);
    expect(beacons).toEqual([]);
  });
});
