import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ cookies: [] as { name: string; value: string }[] }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => request.cookies,
    get: (name: string) => request.cookies.find((cookie) => cookie.name === name),
  }),
  headers: async () => new Headers({ "x-nexus-request-path": "/" }),
}));

import { callFastAPI } from "./server";
import { loadWorkspaceBootstrap } from "@/lib/workspace/bootstrap.server";

let respond: (request: IncomingMessage, response: ServerResponse) => void;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  request.cookies = [{ name: "sb-fixture-auth-token", value: "base64-" + Buffer.from(JSON.stringify({
    access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "bearer",
    expires_at: Math.ceil(Date.now() / 1000) + 300,
  })).toString("base64url") }];
  server = createServer((incoming, outgoing) => respond(incoming, outgoing));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Loopback server did not bind");
  for (const [name, value] of Object.entries({
    NEXUS_ENV: "local", NEXT_PUBLIC_SUPABASE_URL: "https://fixture.supabase.co",
    APP_PUBLIC_URL: "http://localhost:3000", FASTAPI_BASE_URL: `http://127.0.0.1:${address.port}`,
    AUTH_ALLOWED_REDIRECT_ORIGINS: "", AUTH_TRUSTED_PROXY_ORIGINS: "", NEXUS_EXTENSION_REDIRECT_ORIGINS: "", R2_S3_API_ORIGIN: "",
  })) vi.stubEnv(name, value);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  vi.unstubAllEnvs();
});

it("preserves gateway availability and owned errors through the server consumer", async () => {
  for (const status of [502, 503, 504]) {
    respond = (_request, response) => {
      response.writeHead(status, { "content-type": "text/html", "x-request-id": "gateway-request", "retry-after": "2" });
      response.end("<html>temporarily unavailable</html>");
    };
    await expect(callFastAPI("/gateway"), "server gateway lost its availability identity").rejects.toMatchObject({
      status, code: status === 504 ? "E_UPSTREAM_TIMEOUT" : "E_UPSTREAM",
      requestId: "gateway-request", retryAfterMs: 2000,
    });
  }
  respond = (_request, response) => {
    response.writeHead(503, { "content-type": "application/json", "x-request-id": "outer-request" });
    response.end(JSON.stringify({ error: { code: "E_INTERNAL", message: "Owned defect", request_id: "owned-request", details: { scope: "Workspace" } } }));
  };
  await expect(callFastAPI("/owned-defect")).rejects.toMatchObject({
    status: 503, code: "E_INTERNAL", requestId: "owned-request", details: { scope: "Workspace" },
  });
  respond = (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{invalid");
  };
  await expect(callFastAPI("/malformed-success")).rejects.toMatchObject({ status: 200, code: "E_INVALID_RESPONSE" });
});

it("keeps the foreground deadline while the response body is incomplete", async () => {
  let headersSent = false;
  respond = (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    headersSent = true;
    // External server completes after its own response deadline. The consumer's
    // earlier deadline must abort body consumption, not accept this late value.
    const deadline = AbortSignal.timeout(1000);
    const finish = () => response.end('{"data":"late body"}');
    deadline.addEventListener("abort", finish, { once: true });
    response.on("close", () => deadline.removeEventListener("abort", finish));
  };
  const outcome = await callFastAPI("/slow-body", { timeoutMs: 500 }).then(
    (value) => ({ kind: "Success", value }),
    (error: unknown) => ({ kind: "Failure", error }),
  );
  expect(headersSent).toBe(true);
  expect(outcome, "server body escaped its foreground deadline").toMatchObject({
    kind: "Failure", error: { status: 504, code: "E_UPSTREAM_TIMEOUT" },
  });
});

it("omits unavailable optional restore but preserves its owned defects", async () => {
  request.cookies.push({ name: "nx_device", value: "fixture-device" });
  let sessionFailure = "Unavailable";
  respond = (incoming, response) => {
    if (incoming.url?.startsWith("/me/workspace-session?")) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify(sessionFailure === "Unavailable" ? { message: "unavailable" }
        : { error: { code: "E_INTERNAL", message: "Restore contract defect", request_id: "restore-request" } }));
      return;
    }
    const data = incoming.url === "/me" ? {
      user_id: "fixture-account", default_library_id: "fixture-library", email: null, display_name: null,
      calendar_time_zone: "UTC", email_ingest_address: null,
    } : incoming.url === "/me/reader-profile" ? {
      theme: "light", font_family: "serif", font_size_px: 18, line_height: 1.5,
      column_width_ch: 70, focus_mode: "off", hyphenation: "off",
    } : null;
    response.writeHead(data === null ? 503 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data }));
  };
  expect((await loadWorkspaceBootstrap(false)).account.accountId).toBe("fixture-account");
  sessionFailure = "Defect";
  await expect(loadWorkspaceBootstrap(false), "optional restore concealed an owned defect").rejects.toMatchObject({
    code: "E_INTERNAL", requestId: "restore-request",
  });
});
