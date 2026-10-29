import type { ApiJson } from "@/lib/api/wire";

// One browser request has room for the bff and the api's complete operation.
export const SEARCH_READ_TIMEOUT_MS = { direct: 15_000, lexical: 125_000, hybrid: 125_000 } as const satisfies Record<ApiJson<"/search/preview", "get">["phase"], number>;
export const SEARCH_BFF_TIMEOUT_MS = { direct: 10_000, lexical: 120_000, hybrid: 120_000 } as const satisfies Record<ApiJson<"/search/preview", "get">["phase"], number>;
export const searchPrefixTimeoutMs = (pages: number | null) => SEARCH_READ_TIMEOUT_MS.lexical * (pages ?? 51);
