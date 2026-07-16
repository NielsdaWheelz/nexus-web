import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import AuthorPaneBody from "./AuthorPaneBody";

describe("AuthorPaneBody", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears stale author data and filters when the handle changes", async () => {
    const secondContributor = deferred<Response>();
    const secondWorks = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const url = requestUrl(path);
        if (url.pathname === "/api/contributors/first-author") {
          return jsonResponse({
            data: contributor("first-author", "First Author"),
          });
        }
        if (url.pathname === "/api/contributors/first-author/works") {
          return jsonResponse({
            data: {
              works: [
                work({
                  route: "/media/first",
                  title: "First Work",
                  role: "author",
                }),
              ],
            },
          });
        }
        if (isReconciliationRequest(url, "first-author")) {
          return jsonResponse({ data: { candidates: [] } });
        }
        if (url.pathname === "/api/contributors/second-author") {
          return secondContributor.promise;
        }
        if (url.pathname === "/api/contributors/second-author/works") {
          return secondWorks.promise;
        }
        if (isReconciliationRequest(url, "second-author")) {
          return jsonResponse({ data: { candidates: [] } });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    const { rerender } = render(authorPane("first-author"));

    expect(await screen.findByRole("heading", { name: "First Author" })).toBeVisible();
    expect(screen.getByRole("link", { name: /First Work/ })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "author" } });
    expect(screen.getByLabelText("Role")).toHaveValue("author");

    rerender(authorPane("second-author"));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "First Author" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("status")).toBeInTheDocument();

    secondContributor.resolve(jsonResponse({ data: contributor("second-author", "Second Author") }));
    secondWorks.resolve(
      jsonResponse({
        data: {
          works: [
            work({
              route: "/media/second",
              title: "Second Work",
              role: "translator",
            }),
          ],
        },
      }),
    );

    expect(await screen.findByRole("heading", { name: "Second Author" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Second Work/ })).toBeVisible();
    expect(screen.getByLabelText("Role")).toHaveValue("");
  });

  it("reloads works from the backend when filters change", async () => {
    const worksRequests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const url = requestUrl(path);
        if (url.pathname === "/api/contributors/filter-author") {
          return jsonResponse({ data: contributor("filter-author", "Filter Author") });
        }
        if (url.pathname === "/api/contributors/filter-author/works") {
          worksRequests.push(url);
          if (
            url.searchParams.get("role") === "translator" ||
            url.searchParams.get("content_kind") === "pdf" ||
            url.searchParams.get("q") === "selected"
          ) {
            return jsonResponse({
              data: {
                works: [
                  work({
                    route: "/media/selected",
                    title: "Selected Work",
                    role: "translator",
                    contentKind: "pdf",
                  }),
                ],
              },
            });
          }
          return jsonResponse({
            data: {
              works: [
                work({
                  route: "/media/initial",
                  title: "Initial Work",
                  role: "author",
                  contentKind: "epub",
                }),
                work({
                  route: "/media/selected",
                  title: "Selected Work",
                  role: "translator",
                  contentKind: "pdf",
                }),
              ],
            },
          });
        }
        if (isReconciliationRequest(url, "filter-author")) {
          return jsonResponse({ data: { candidates: [] } });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    render(authorPane("filter-author"));

    expect(await screen.findByRole("heading", { name: "Filter Author" })).toBeVisible();
    await waitFor(() => {
      expect(worksRequests).toHaveLength(1);
    });

    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "translator" },
    });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "pdf" } });
    fireEvent.change(screen.getByLabelText("Search works"), {
      target: { value: "selected" },
    });

    await waitFor(() => {
      const lastRequest = worksRequests[worksRequests.length - 1];
      expect(lastRequest?.searchParams.get("role")).toBe("translator");
      expect(lastRequest?.searchParams.get("content_kind")).toBe("pdf");
      expect(lastRequest?.searchParams.get("q")).toBe("selected");
      expect(lastRequest?.searchParams.get("limit")).toBe("100");
    });
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: /Initial Work/ })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: /Selected Work/ })).toBeVisible();
  });

  it("merges into a picked target then navigates to the survivor", async () => {
    let mergeBody: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        const url = requestUrl(path);
        if (url.pathname === "/api/contributors/source-author") {
          return jsonResponse({ data: contributor("source-author", "Source Author") });
        }
        if (url.pathname === "/api/contributors/source-author/works") {
          return jsonResponse({ data: { works: [] } });
        }
        if (isReconciliationRequest(url, "source-author")) {
          return jsonResponse({ data: { candidates: [] } });
        }
        if (url.pathname === "/api/contributors" && init?.method !== "POST") {
          return jsonResponse({
            data: { contributors: [contributor("target-author", "Target Author")] },
          });
        }
        if (url.pathname === "/api/contributors/source-author/merge") {
          mergeBody = init?.body ? JSON.parse(init.body as string) : null;
          return jsonResponse({ data: contributor("target-author", "Target Author") });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    const onNavigatePane = vi.fn();
    render(authorPane("source-author", { onNavigatePane }));

    expect(await screen.findByRole("heading", { name: "Source Author" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Merge into/ }));

    const dialog = await screen.findByRole("dialog", { name: "Merge author" });
    fireEvent.change(screen.getByLabelText("Search authors"), {
      target: { value: "target" },
    });
    const targetButton = await screen.findByRole("button", { name: "Target Author" });
    fireEvent.click(targetButton);

    await waitFor(() => {
      expect(mergeBody).toEqual({ target_handle: "target-author" });
    });
    await waitFor(() => {
      expect(onNavigatePane).toHaveBeenCalledWith(
        "pane-1",
        "/authors/target-author",
        undefined,
      );
    });
    expect(dialog).not.toBeInTheDocument();
  });

  it("accepts a duplicate suggestion through the reconciliation endpoint", async () => {
    const candidate = reconciliationCandidate("candidate-1", "source-author", "target-author");
    let acceptedCandidateId: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        const url = requestUrl(path);
        if (url.pathname === "/api/contributors/source-author") {
          return jsonResponse({ data: contributor("source-author", "Source Author") });
        }
        if (url.pathname === "/api/contributors/source-author/works") {
          return jsonResponse({ data: { works: [] } });
        }
        if (isReconciliationRequest(url, "source-author")) {
          return jsonResponse({ data: { candidates: [candidate] } });
        }
        if (
          url.pathname === "/api/contributors/reconciliation-candidates/candidate-1/accept" &&
          init?.method === "POST"
        ) {
          acceptedCandidateId = "candidate-1";
          return jsonResponse({ data: contributor("target-author", "Target Author") });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    const onNavigatePane = vi.fn();
    render(authorPane("source-author", { onNavigatePane }));

    expect(await screen.findByRole("heading", { name: "Possible Duplicates" })).toBeVisible();
    expect(await screen.findByText("Target Author")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Accept merge" }));

    await waitFor(() => {
      expect(acceptedCandidateId).toBe("candidate-1");
      expect(onNavigatePane).toHaveBeenCalledWith(
        "pane-1",
        "/authors/target-author",
        undefined,
      );
    });
  });

  it("refreshes in place when accepting a duplicate suggestion on the survivor page", async () => {
    const candidate = reconciliationCandidate("candidate-1", "source-author", "target-author");
    let accepted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        const url = requestUrl(path);
        if (url.pathname === "/api/contributors/target-author") {
          return jsonResponse({ data: contributor("target-author", "Target Author") });
        }
        if (url.pathname === "/api/contributors/target-author/works") {
          return jsonResponse({ data: { works: [] } });
        }
        if (isReconciliationRequest(url, "target-author")) {
          return jsonResponse({ data: { candidates: accepted ? [] : [candidate] } });
        }
        if (
          url.pathname === "/api/contributors/reconciliation-candidates/candidate-1/accept" &&
          init?.method === "POST"
        ) {
          accepted = true;
          return jsonResponse({ data: contributor("target-author", "Target Author") });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    const onNavigatePane = vi.fn();
    render(authorPane("target-author", { onNavigatePane }));

    expect(await screen.findByRole("heading", { name: "Possible Duplicates" })).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Accept merge" }));

    await waitFor(() => {
      expect(onNavigatePane).not.toHaveBeenCalled();
      expect(screen.queryByText("Source Author")).not.toBeInTheDocument();
    });
  });

  it("keeps the author pane visible when duplicate suggestions fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const url = requestUrl(path);
        if (url.pathname === "/api/contributors/stable-author") {
          return jsonResponse({ data: contributor("stable-author", "Stable Author") });
        }
        if (url.pathname === "/api/contributors/stable-author/works") {
          return jsonResponse({
            data: {
              works: [work({ route: "/media/stable", title: "Stable Work", role: "author" })],
            },
          });
        }
        if (isReconciliationRequest(url, "stable-author")) {
          return new Response(
            JSON.stringify({
              error: { code: "E_INTERNAL", message: "suggestions unavailable" },
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    render(authorPane("stable-author"));

    expect(await screen.findByRole("heading", { name: "Stable Author" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Stable Work/ })).toBeVisible();
    expect(await screen.findByText("Failed to load duplicate suggestions")).toBeVisible();
  });

  it("links the search pivot to the contributor handle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const url = requestUrl(path);
        if (url.pathname === "/api/contributors/pivot-author") {
          return jsonResponse({ data: contributor("pivot-author", "Pivot Author") });
        }
        if (url.pathname === "/api/contributors/pivot-author/works") {
          return jsonResponse({ data: { works: [] } });
        }
        if (isReconciliationRequest(url, "pivot-author")) {
          return jsonResponse({ data: { candidates: [] } });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    render(authorPane("pivot-author"));

    expect(await screen.findByRole("heading", { name: "Pivot Author" })).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Search this author's works/ }),
    ).toHaveAttribute("href", "/search?authors=pivot-author");
  });

  it("shows a 'Formerly' note when the URL handle was merged away", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        const url = requestUrl(path);
        // The backend follows merges: the requested old handle resolves to the survivor.
        if (url.pathname === "/api/contributors/old-handle") {
          return jsonResponse({ data: contributor("new-handle", "Merged Author") });
        }
        if (url.pathname === "/api/contributors/old-handle/works") {
          return jsonResponse({ data: { works: [] } });
        }
        if (isReconciliationRequest(url, "old-handle")) {
          return jsonResponse({ data: { candidates: [] } });
        }
        throw new Error(`Unexpected fetch path: ${path}`);
      }),
    );

    render(authorPane("old-handle"));

    expect(await screen.findByRole("heading", { name: "Merged Author" })).toBeVisible();
    expect(screen.getByText("Formerly old-handle")).toBeVisible();
  });
});

function authorPane(
  handle: string,
  options: { onNavigatePane?: (paneId: string, href: string) => void } = {},
) {
  const href = `/authors/${handle}`;
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      isActive={true}
      href={href}
      routeId="author"
      routeKey={resolvePaneRouteIdentity(href).routeKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      pathParams={{ handle }}
      onNavigatePane={options.onNavigatePane ?? (() => {})}
      onReplacePane={() => {}}
      onOpenInNewPane={() => {}}
    >
      <AuthorPaneBody />
    </PaneRuntimeProvider>
  );
}

function contributor(handle: string, displayName: string) {
  return {
    handle,
    display_name: displayName,
    sort_name: displayName,
    kind: "person",
    status: "verified",
    disambiguation: null,
    aliases: [],
    external_ids: [],
  };
}

function requestUrl(path: string): URL {
  return new URL(path, "https://nexus.test");
}

function isReconciliationRequest(url: URL, handle: string): boolean {
  return (
    url.pathname === "/api/contributors/reconciliation-candidates" &&
    url.searchParams.get("contributor_handle") === handle
  );
}

function work(input: { route: string; title: string; role: string; contentKind?: string }) {
  return {
    object_type: "media",
    object_id: input.route.split("/").pop() ?? input.route,
    route: input.route,
    title: input.title,
    content_kind: input.contentKind ?? "epub",
    role: input.role,
    credited_name: input.title,
    published_date: null,
    publisher: null,
    description: null,
    source: "local",
  };
}

function reconciliationCandidate(id: string, sourceHandle: string, targetHandle: string) {
  return {
    id,
    status: "pending",
    score: 82,
    source_contributor: {
      ...contributor(sourceHandle, "Source Author"),
      href: `/authors/${sourceHandle}`,
      work_count: 1,
    },
    target_contributor: {
      ...contributor(targetHandle, "Target Author"),
      href: `/authors/${targetHandle}`,
      work_count: 2,
    },
    evidence: {
      matcher: "deterministic",
      algorithm_version: "contributor_reconciliation_v2",
      reason: "test",
      score: 82,
      signals: ["shared_alias"],
      shared_aliases: ["source author"],
      shared_confirmed_aliases: [],
      shared_work_count: 1,
      source_handle: sourceHandle,
      target_handle: targetHandle,
      source_work_count: 1,
      target_work_count: 2,
      source_confirmed_alias_count: 0,
      target_confirmed_alias_count: 0,
      source_strong_external_id_count: 0,
      target_strong_external_id_count: 0,
    },
    created_at: "2026-07-07T00:00:00Z",
    updated_at: "2026-07-07T00:00:00Z",
    decided_at: null,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
