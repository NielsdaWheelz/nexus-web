import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatModels } from "./useChatModels";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url).pathname;
  return new URL(String(input), "http://localhost").pathname;
}

describe("useChatModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps a failed model load terminal across remounts", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === "/api/models") {
        return jsonResponse(
          { error: { code: "E_INTERNAL", message: "Models unavailable" } },
          500,
        );
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderHook(() =>
      useChatModels({ onlyUseMyKeys: false }),
    );
    await waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));
    unmount();

    renderHook(() => useChatModels({ onlyUseMyKeys: false }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(2));

    expect(
      fetchMock.mock.calls.filter(([input]) => pathOf(input) === "/api/models"),
    ).toHaveLength(1);
  });
});
