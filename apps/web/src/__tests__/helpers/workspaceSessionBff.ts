import { vi } from "vitest";

export function installWorkspaceSessionBff() {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      const method = init?.method ?? request?.method ?? "GET";
      if (url.pathname === "/api/me/workspace-session" && method === "PUT") {
        return new Response(JSON.stringify({ data: null }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected BFF request: ${method} ${url.pathname}`);
    },
  );
}
