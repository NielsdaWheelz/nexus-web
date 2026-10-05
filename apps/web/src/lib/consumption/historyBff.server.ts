import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { privateNoStoreResponse } from "@/lib/api/privateNoStoreResponse.server";
import { proxyToFastAPI } from "@/lib/api/proxy";
import { readDeviceId } from "@/lib/auth/deviceCookie";

// Device identity is server-owned: only this BFF names the device, from the httpOnly nx_device
// cookie, overwriting anything the client sent. FastAPI is the sole validator of the capture
// body.

const failure = (status: number, code: string, message: string) =>
  privateNoStoreResponse(NextResponse.json({ error: { code, message } }, { status }));

/** The device cookie, which authenticated middleware mints before any request reaches here. */
async function deviceId(): Promise<string | null> {
  const id = readDeviceId(await cookies());
  if (id === null) console.error("consumption_history_device_cookie_missing");
  return id;
}

export async function postActivity(request: Request): Promise<Response> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 48_000) {
    return failure(413, "E_CAPTURE_TOO_LARGE", "Activity batch is too large");
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Not JSON: rejected below with every other non-object body.
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return failure(400, "E_INVALID_REQUEST", "Invalid activity batch");
  }
  const device = await deviceId();
  if (device === null) return failure(500, "E_INTERNAL", "Device cookie missing");
  const { headers, signal } = request;
  const forwarded = JSON.stringify({ ...body, deviceId: device });
  const init = { method: "POST", headers, body: forwarded, signal };
  return proxyToFastAPI(new Request(request.url, init), "/consumption/activity");
}

export async function proxyConsumptionRead(
  request: Request,
  backendPath: "/consumption/stats" | "/consumption/sessions",
): Promise<Response> {
  const device = await deviceId();
  if (device === null) return failure(500, "E_INTERNAL", "Device cookie missing");
  const url = new URL(request.url);
  url.searchParams.set("currentDeviceId", device);
  const { headers, signal } = request;
  return proxyToFastAPI(new Request(url, { method: "GET", headers, signal }), backendPath);
}
