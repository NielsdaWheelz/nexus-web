import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
        if (url.pathname === "/api/contributors/second-author") {
          return secondContributor.promise;
        }
        if (url.pathname === "/api/contributors/second-author/works") {
          return secondWorks.promise;
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
    expect(screen.getByText("Loading author...")).toBeInTheDocument();

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
});

function authorPane(handle: string) {
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      href={`/authors/${handle}`}
      routeId="author"
      resourceRef={handle}
      pathParams={{ handle }}
      onNavigatePane={() => {}}
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
