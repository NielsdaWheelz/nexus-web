import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { proxyToFastAPI } from "@/lib/api/proxy";
import { readDeviceId } from "@/lib/auth/deviceCookie";

export const runtime = "nodejs";

// The device id is a server-owned httpOnly cookie (lib/auth/deviceCookie), never trusted from
// the client. Both verbs inject it from the cookie: GET appends ?device_id=, PUT injects it
// into the body — any client-supplied device_id is ignored. The app shell restores on the
// server (bootstrap.server.ts), so the production client never calls GET; it remains for
// read-back/debugging and is the seam the e2e suite reads capture through.

// The cookie is minted in middleware on the authenticated page load that necessarily precedes
// any workspace-session call, so its absence on an authenticated request here is a broken
// invariant, not a recoverable client error.
function deviceCookieMissingDefect(): NextResponse {
  // justify-defect: server-minted device identity is absent on an authenticated request.
  console.error("workspace_session_device_cookie_missing");
  return NextResponse.json(
    { error: { code: "E_INTERNAL", message: "Device cookie missing" } },
    { status: 500 }
  );
}

export async function GET(req: Request) {
  const deviceId = readDeviceId(await cookies());
  if (!deviceId) {
    return deviceCookieMissingDefect();
  }
  const url = new URL(req.url);
  url.search = `?device_id=${encodeURIComponent(deviceId)}`;
  return proxyToFastAPI(new Request(url, { method: "GET", headers: req.headers }), "/me/workspace-session");
}

export async function PUT(req: Request) {
  const deviceId = readDeviceId(await cookies());
  if (!deviceId) {
    return deviceCookieMissingDefect();
  }
  const { state } = (await req.json()) as { state: unknown };
  const forwarded = new Request(req.url, {
    method: "PUT",
    headers: req.headers,
    body: JSON.stringify({ state, device_id: deviceId }),
  });
  return proxyToFastAPI(forwarded, "/me/workspace-session");
}
