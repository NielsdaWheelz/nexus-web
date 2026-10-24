import type { ApiJson } from "@/lib/api/wire";

// Browser whole-read and BFF headers/body caps; API operations have smaller caps.
export const SEARCH_READ_TIMEOUT_MS = { direct: 1000, lexical: 2250, hybrid: 3750 } as const satisfies Record<ApiJson<"/search/preview", "get">["phase"], number>;
