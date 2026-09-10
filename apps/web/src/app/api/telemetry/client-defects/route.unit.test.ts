/// <reference types="vite/client" />

import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const routeModules = import.meta.glob<typeof import("./route")>("./route.ts");

const originalEnvironment = { ...process.env };
const release = "a".repeat(40);
const report = {
  pane_id: "pane",
  visit_id: "visit",
  phase: "Render",
  command_id: { kind: "Absent" },
  run_id: { kind: "Absent" },
  error_code: "E_CLIENT_DEFECT",
  request_id: { kind: "Absent" },
  component_stack: "\n    at BrokenPane",
} as const;

function authenticatedCookie(): string {
  const value = Buffer.from(
    JSON.stringify({
      access_token: "authenticated-access-token",
      expires_at: 4_102_444_800,
      refresh_token: "refresh-token",
      token_type: "bearer",
    }),
  ).toString("base64url");
  return `sb-fixture-auth-token=base64-${value}`;
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("POST /api/telemetry/client-defects", () => {
  it("authenticates and forwards only the release-bound report to its exact backend route", async () => {
    const loadRoute = routeModules["./route.ts"];
    expect(loadRoute, "client defect route owner is missing").toBeTypeOf(
      "function",
    );
    const { POST } = await loadRoute();
    let receive!: (value: {
      url: string;
      authorization: string | undefined;
      cookie: string | undefined;
      body: unknown;
    }) => void;
    const received = new Promise<{
      url: string;
      authorization: string | undefined;
      cookie: string | undefined;
      body: unknown;
    }>((resolve) => {
      receive = resolve;
    });
    const server = createServer(async (request, response) => {
      receive({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        body: JSON.parse(await requestBody(request)),
      });
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("client defect proof did not acquire a loopback port");
    }

    process.env.NEXUS_ENV = "test";
    process.env.APP_PUBLIC_URL = "http://localhost:3000";
    process.env.FASTAPI_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.NEXUS_INTERNAL_SECRET = "test-internal-secret";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
    process.env.VERCEL_GIT_COMMIT_SHA = release;
    const request = (body: unknown) =>
      new Request("http://localhost:3000/api/telemetry/client-defects", {
        method: "POST",
        headers: {
          Cookie: authenticatedCookie(),
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    try {
      const spoofed = await POST(request({ ...report, release: "spoofed" }));
      expect(spoofed.status).toBe(400);

      const response = await POST(request(report));
      expect(response.status).toBe(204);
      await expect(received).resolves.toEqual({
        url: "/telemetry/client-defects",
        authorization: "Bearer authenticated-access-token",
        cookie: undefined,
        body: { ...report, release },
      });
    } finally {
      await close(server);
    }
  });
});
