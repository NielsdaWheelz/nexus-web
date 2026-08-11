import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { privateNoStoreResponse } from "@/lib/api/privateNoStoreResponse.server";
import { proxyToFastAPI } from "@/lib/api/proxy";
import { readDeviceId } from "@/lib/auth/deviceCookie";
import { decodeActivityAdjustmentRequest } from "./activityAdjustments";
import {
  decodeActivityRequest,
  type ActivityRequest,
} from "./activityContract";

const ACTIVITY_BATCH_MAX_BYTES = 48_000;

interface ActivityRouteDependencies {
  readonly deviceId: typeof consumptionDeviceId;
  readonly proxy: typeof proxyToFastAPI;
}

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

export async function postActivityWithDependencies(
  request: Request,
  dependencies: ActivityRouteDependencies,
): Promise<Response> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > ACTIVITY_BATCH_MAX_BYTES) {
    return activityTooLargeResponse();
  }

  let decoded: ActivityRequest;
  try {
    decoded = decodeActivityRequest(JSON.parse(raw));
  } catch {
    return invalidConsumptionRequest("Invalid activity batch");
  }

  const device = await dependencies.deviceId();
  if (device.kind === "Defect") return device.response;
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({
      clientMutationId: decoded.clientMutationId,
      mediaRef: decoded.mediaRef,
      deviceId: device.value,
      deviceClass: decoded.deviceClass,
      batch: decoded.batch,
    }),
    signal: request.signal,
  });
  return privateNoStoreResponse(
    await dependencies.proxy(forwarded, "/consumption/activity"),
  );
}

export async function postActivityAdjustmentWithProxy(
  request: Request,
  proxy: typeof proxyToFastAPI,
): Promise<Response> {
  let decoded: ReturnType<typeof decodeActivityAdjustmentRequest>;
  try {
    decoded = decodeActivityAdjustmentRequest(await request.json());
  } catch {
    return invalidConsumptionRequest("Invalid activity adjustment");
  }
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(decoded),
    signal: request.signal,
  });
  return privateNoStoreResponse(
    await proxy(forwarded, "/consumption/activity-adjustments"),
  );
}
