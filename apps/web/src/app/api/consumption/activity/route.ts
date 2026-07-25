import { privateNoStoreResponse } from "@/lib/api/privateNoStoreResponse.server";
import { proxyToFastAPI } from "@/lib/api/proxy";
import {
  decodeActivityRequest,
  type ActivityRequest,
} from "@/lib/consumption/activityContract";
import {
  activityTooLargeResponse,
  consumptionDeviceId,
  invalidConsumptionRequest,
} from "@/lib/consumption/historyBff.server";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";

export const runtime = "nodejs";

const ACTIVITY_BATCH_MAX_BYTES = 48_000;

function mediaId(request: ActivityRequest): string {
  const ref = parseResourceRef(request.mediaRef);
  if (ref === null || ref.scheme !== "media") {
    // justify-defect: decodeActivityRequest has already established this exact
    // canonical media ResourceRef.
    throw new Error("Decoded activity request has an invalid mediaRef");
  }
  return ref.id;
}

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > ACTIVITY_BATCH_MAX_BYTES) {
    return activityTooLargeResponse();
  }

  let decoded: ActivityRequest;
  try {
    decoded = decodeActivityRequest(JSON.parse(raw) as unknown);
  } catch {
    return invalidConsumptionRequest("Invalid activity batch");
  }

  const device = await consumptionDeviceId();
  if (device.kind === "Defect") {
    return device.response;
  }
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({
      clientMutationId: decoded.clientMutationId,
      mediaId: mediaId(decoded),
      deviceId: device.value,
      deviceClass: decoded.deviceClass,
      batch: decoded.batch,
    }),
    signal: request.signal,
  });
  return privateNoStoreResponse(
    await proxyToFastAPI(forwarded, "/consumption/activity"),
  );
}
