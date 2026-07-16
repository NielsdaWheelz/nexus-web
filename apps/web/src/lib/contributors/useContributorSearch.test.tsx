import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useContributorSearch } from "./useContributorSearch";

function Harness({ query, reloadToken }: { query: string; reloadToken?: number }) {
  const state = useContributorSearch(query, { limit: 10, reloadToken });
  return <div data-testid="state">{JSON.stringify(state)}</div>;
}

function searchItem(handle: string, displayName: string) {
  return {
    handle,
    href: `/authors/${handle}`,
    displayName,
    workCount: 1,
    workExamples: [],
    matchedAlias: null,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function readState(): { status: string; items?: unknown[] } {
  return JSON.parse(screen.getByTestId("state").textContent ?? "{}");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useContributorSearch", () => {
  it("stays idle for a blank query without fetching", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness query="   " />);
    expect(readState().status).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves to ready with decoded items for a non-blank query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: {
            contributors: [
              {
                handle: "ursula-le-guin",
                href: "/authors/ursula-le-guin",
                displayName: "Ursula K. Le Guin",
                workCount: 2,
                workExamples: [],
                matchedAlias: null,
              },
            ],
            nextCursor: null,
          },
        }),
      ),
    );
    render(<Harness query="le" />);
    await waitFor(() => expect(readState().status).toBe("ready"));
    expect(readState().items).toHaveLength(1);
  });

  it("resolves to empty when the query has no matches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { contributors: [], nextCursor: null } })),
    );
    render(<Harness query="zzz" />);
    await waitFor(() => expect(readState().status).toBe("empty"));
  });

  it("surfaces a request failure as error, never as an empty list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    render(<Harness query="le" />);
    await waitFor(() => expect(readState().status).toBe("error"));
    expect(readState().items).toBeUndefined();
  });

  it("suppresses a stale response: a late older request cannot clobber the newer query (D-34)", async () => {
    const resolvers = new Map<string, (contributors: unknown[]) => void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | Request) => {
        const raw = input instanceof Request ? input.url : String(input);
        const q = new URL(raw, "https://nexus.test").searchParams.get("q") ?? "";
        return await new Promise<Response>((resolve) => {
          resolvers.set(q, (contributors) =>
            resolve(jsonResponse({ data: { contributors, nextCursor: null } })),
          );
        });
      }),
    );

    const { rerender } = render(<Harness query="older" />);
    await waitFor(() => expect(resolvers.has("older")).toBe(true));

    // Switch to a newer query while the older request is still in flight.
    rerender(<Harness query="newer" />);
    await waitFor(() => expect(resolvers.has("newer")).toBe(true));

    // The NEWER request resolves first and wins.
    resolvers.get("newer")!([searchItem("newer-author", "Newer")]);
    await waitFor(() => expect(readState().status).toBe("ready"));
    expect(readState().items).toHaveLength(1);

    // The OLDER request resolves late; its request id is stale, so it must NOT
    // overwrite the newer "ready" state.
    resolvers.get("older")!([searchItem("older-a", "A"), searchItem("older-b", "B")]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readState().status).toBe("ready");
    expect(readState().items).toHaveLength(1);
  });

  it("re-fetches the same query when reloadToken changes (honest retry, no query perturbation)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({ data: { contributors: [], nextCursor: null } });
      }),
    );
    const { rerender } = render(<Harness query="le" reloadToken={0} />);
    await waitFor(() => expect(readState().status).toBe("empty"));
    expect(calls).toBe(1);

    rerender(<Harness query="le" reloadToken={1} />);
    await waitFor(() => expect(calls).toBe(2));
  });
});
