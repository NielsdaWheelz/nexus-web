import { proxyToFastAPI } from "@/lib/api/proxy";
import {
  consumptionDeviceId,
  postActivityWithDependencies,
} from "@/lib/consumption/historyBff.server";

export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return postActivityWithDependencies(request, {
    deviceId: consumptionDeviceId,
    proxy: proxyToFastAPI,
  });
}
