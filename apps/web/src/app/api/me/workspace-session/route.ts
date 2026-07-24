import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { proxyToFastAPI } from "@/lib/api/proxy";
import { readDeviceId } from "@/lib/auth/deviceCookie";
import {
  InvalidWorkspaceStateError,
  parsePersistedWorkspaceState,
  type WorkspaceState,
} from "@/lib/workspace/schema";
import { isRecord } from "@/lib/validation";

export const runtime = "nodejs";

// The device id is a server-owned httpOnly cookie (lib/auth/deviceCookie), never trusted from
// the client. Both verbs inject it from the cookie: GET appends ?device_id=, PUT injects it
// into the body. The PUT boundary accepts only the exact client-owned `{ state }`
// envelope, so a client-supplied device id is rejected rather than ignored. The app shell restores on the
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

function invalidWorkspaceState(message: string): NextResponse {
  return NextResponse.json(
    { error: { code: "E_INVALID_WORKSPACE_STATE", message } },
    { status: 400 },
  );
}

async function readWorkspaceState(req: Request): Promise<WorkspaceState> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    throw new InvalidWorkspaceStateError("Request body must be valid JSON");
  }
  if (
    !isRecord(payload) ||
    Object.keys(payload).length !== 1 ||
    !Object.hasOwn(payload, "state")
  ) {
    throw new InvalidWorkspaceStateError(
      "Request body must contain exactly [state]",
    );
  }
  return parsePersistedWorkspaceState(payload.state, {
    baseOrigin: new URL(req.url).origin,
  });
}

export async function PUT(req: Request) {
  const deviceId = readDeviceId(await cookies());
  if (!deviceId) {
    return deviceCookieMissingDefect();
  }
  let state: WorkspaceState;
  try {
    state = await readWorkspaceState(req);
  } catch (error) {
    if (error instanceof InvalidWorkspaceStateError) {
      return invalidWorkspaceState(error.message);
    }
    throw error;
  }
  const forwarded = new Request(req.url, {
    method: "PUT",
    headers: req.headers,
    body: JSON.stringify({ state, device_id: deviceId }),
  });
  return proxyToFastAPI(forwarded, "/me/workspace-session");
}
