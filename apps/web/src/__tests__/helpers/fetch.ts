import { vi } from "vitest";

export function fetchInputPath(input: unknown): string {
  if (input instanceof Request) {
    return new URL(input.url, "http://localhost").pathname;
  }
  return new URL(String(input), "http://localhost").pathname;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function stubFetch(
  implementation: typeof fetch = async () => Response.json({}),
) {
  const fetchMock = vi.fn<typeof fetch>(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function fetchCallsForPath(
  fetchMock: ReturnType<typeof stubFetch>,
  path: string,
) {
  return fetchMock.mock.calls.filter(
    ([input]) => fetchInputPath(input) === path,
  );
}

export function wasFetchPathCalled(
  fetchMock: ReturnType<typeof stubFetch>,
  path: string,
): boolean {
  return fetchCallsForPath(fetchMock, path).length > 0;
}
