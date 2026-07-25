import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { privateNoStoreResponse } from "@/lib/api/privateNoStoreResponse.server";
import { proxyToFastAPI } from "@/lib/api/proxy";
import { readDeviceId } from "@/lib/auth/deviceCookie";

function privateJson(
  body: { error: { code: string; message: string } },
  status: number,
): Response {
  return privateNoStoreResponse(NextResponse.json(body, { status }));
}

export function invalidConsumptionRequest(message: string): Response {
  return privateJson(
    { error: { code: "E_INVALID_REQUEST", message } },
    400,
  );
}

export function activityTooLargeResponse(): Response {
  return privateJson(
    {
      error: {
        code: "E_CAPTURE_TOO_LARGE",
        message: "Activity batch is too large",
      },
    },
    413,
  );
}

export async function consumptionDeviceId(): Promise<
  { kind: "Present"; value: string } | { kind: "Defect"; response: Response }
> {
  const deviceId = readDeviceId(await cookies());
  if (deviceId !== null) {
    return { kind: "Present", value: deviceId };
  }
  // justify-defect: authenticated app middleware must mint nx_device before a
  // private Consumption-history request can reach its BFF.
  console.error("consumption_history_device_cookie_missing");
  return {
    kind: "Defect",
    response: privateJson(
      { error: { code: "E_INTERNAL", message: "Device cookie missing" } },
      500,
    ),
  };
}

export async function proxyConsumptionRead(
  request: Request,
  backendPath: "/consumption/stats" | "/consumption/sessions",
): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.has("currentDeviceId")) {
    return invalidConsumptionRequest("currentDeviceId is server-owned");
  }
  const device = await consumptionDeviceId();
  if (device.kind === "Defect") {
    return device.response;
  }
  url.searchParams.set("currentDeviceId", device.value);
  const forwarded = new Request(url, {
    method: "GET",
    headers: request.headers,
    signal: request.signal,
  });
  return privateNoStoreResponse(
    await proxyToFastAPI(forwarded, backendPath),
  );
}
