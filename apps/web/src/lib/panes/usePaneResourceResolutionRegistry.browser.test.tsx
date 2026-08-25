import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { PaneResourceLocator } from "./paneResourceLocator";
import { paneResourceLocatorKey } from "./paneResourceLocator";
import { usePaneResourceResolutionRegistry } from "./usePaneResourceResolutionRegistry";

const PAGE_A = "11111111-1111-4111-8111-111111111111";
const PAGE_B = "22222222-2222-4222-8222-222222222222";

function locator(id: string): PaneResourceLocator {
  return { kind: "resource_ref", ref: `page:${id}` };
}

function resourceItem(id: string, missing = false) {
  const ref = `page:${id}`;
  const route = missing ? null : `/pages/${id}`;
  return {
    ref,
    scheme: "page",
    id,
    label: missing ? "(resource unavailable)" : `Page ${id}`,
    summary: "",
    route,
    activation: {
      resourceRef: ref,
      kind: missing ? "none" : "route",
      href: route,
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
  if (candidate.kind !== "resource_ref") {
    throw new Error("This test fixture only supports resource refs");
  }
  const id = candidate.ref.slice("page:".length);
  const item = resourceItem(id, missing);
  return {
    locator: candidate,
    resourceItem: item,
    canonicalHref: item.route,
  };
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

afterEach(() => vi.unstubAllGlobals());

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

  it("discards an in-flight result after its locator leaves the live set", async () => {
    const request = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => request.promise),
    );
    const { rerender } = render(
      <Harness locators={locatorMap(locator(PAGE_A))} />,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    rerender(<Harness locators={locatorMap()} />);
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

  it("raises a malformed same-system response through the render boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { resolutions: [] } })),
    );

    render(
      <DefectBoundary>
        <Harness locators={locatorMap(locator(PAGE_A))} />
      </DefectBoundary>,
    );

    expect(await screen.findByText("registry-defect")).toBeVisible();
  });
});
