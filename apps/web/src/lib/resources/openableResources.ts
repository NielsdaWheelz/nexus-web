import type { Presence } from "@/lib/api/presence";
import { apiFetch } from "@/lib/api/client";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import {
  decodeResourceItem,
  type ResourceItem,
} from "@/lib/resources/resourceItems";
import {
  beginSwitchboardPerformance,
  cancelSwitchboardPerformance,
  markSwitchboardPerformanceDecoded,
  NEXUS_OPENABLES_PERFORMANCE,
} from "@/lib/switchboard/performance";
import { expectArray, expectExactRecord } from "@/lib/validation";

export interface ResourceOpenableSearchRequest {
  q: string;
  schemes: Presence<readonly ResourceScheme[]>;
  signal?: AbortSignal;
}

export interface ResourceOpenableSearchResponse {
  items: ResourceItem[];
}

export class ResourceOpenablesContractDefect extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceOpenablesContractDefect";
  }
}

export async function searchOpenableResources(
  request: ResourceOpenableSearchRequest,
): Promise<ResourceOpenableSearchResponse> {
  const performanceRun = beginSwitchboardPerformance(
    NEXUS_OPENABLES_PERFORMANCE,
  );
  try {
    const response = await apiFetch<{ data: unknown }>(
      "/api/resource-items/openables/search",
      {
        method: "POST",
        signal: request.signal,
        body: JSON.stringify({ q: request.q, schemes: request.schemes }),
      },
    );
    let result: ResourceOpenableSearchResponse;
    try {
      const data = expectExactRecord(
        response.data,
        ["items"],
        "openable resource response",
      );
      result = {
        items: expectArray(
          data.items,
          (item) => decodeResourceItem(item),
          "openable resource response.items",
        ),
      };
    } catch (error) {
      if (error instanceof TypeError) {
        throw new ResourceOpenablesContractDefect(error.message);
      }
      throw error;
    }
    markSwitchboardPerformanceDecoded(
      NEXUS_OPENABLES_PERFORMANCE,
      performanceRun,
    );
    return result;
  } catch (error) {
    cancelSwitchboardPerformance(
      NEXUS_OPENABLES_PERFORMANCE,
      performanceRun,
    );
    throw error;
  }
}
