import "server-only";

import { callFastAPI } from "@/lib/api/server";
import { PREFETCH_OPTS, type ResourceFetcher } from "@/lib/api/resourceTransport";

// The active pane's server seed uses a bounded upstream read. Pane loaders share
// their parsing/composition with the client through this transport boundary.
export const serverResourceFetcher: ResourceFetcher = (descriptor, params) =>
  callFastAPI(descriptor.serverPath(params), PREFETCH_OPTS);
