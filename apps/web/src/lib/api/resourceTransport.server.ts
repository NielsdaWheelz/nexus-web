import "server-only";

import { callFastAPI } from "@/lib/api/server";
import { PREFETCH_OPTS, type ResourceFetcher } from "@/lib/api/resourceTransport";

// Server transport: bearer-authenticated upstream fetch with the paint-adjacent
// deadline baked in. The only server/client difference is here and in the client fetcher.
export const serverResourceFetcher: ResourceFetcher = (descriptor, params) =>
  callFastAPI(descriptor.serverPath(params), PREFETCH_OPTS);
