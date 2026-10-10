import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { proxyToFastAPI } from "@/lib/api/proxy";
import { readDeviceId } from "@/lib/auth/deviceCookie";

export const runtime = "nodejs";

// Saves this device's workspace. The api validates the body; the device is
// the server-owned httpOnly cookie, put in the query so a client cannot name one.
export async function PUT(req: Request) {
  const deviceId = readDeviceId(await cookies());
  if (!deviceId) {
    // justify-defect: middleware mints the cookie on the page load that precedes any save.
    console.error("workspace_session_device_cookie_missing");
    return NextResponse.json(
      { error: { code: "E_INTERNAL", message: "Device cookie missing" } },
      { status: 500 },
    );
  }
  const url = new URL(req.url);
  url.search = new URLSearchParams({ device_id: deviceId }).toString();
  const forwarded = new Request(url, {
    method: "PUT",
    headers: req.headers,
    body: await req.arrayBuffer(),
  });
  return proxyToFastAPI(forwarded, "/me/workspace-session");
}
