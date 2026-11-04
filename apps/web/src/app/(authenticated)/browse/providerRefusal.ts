/** A discovery provider's refusal, which nexus relays (services/browse/targets.py): the domain
 * reason ahead of the transport. Null when the error is not the provider's, so the transport
 * speaks. `retry` says whether asking again can help. */
import type { ApiError } from "@/lib/api/client";
import { formatDisplayDate } from "@/lib/display/format";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";

export function providerRefusal(error: ApiError, display: RenderEnvironment): { readonly reason: string; readonly retry: boolean } | null {
  switch (error.code) {
    case "E_BROWSE_PROVIDER_UNAVAILABLE":
      return { reason: "the source isn’t available.", retry: true };
    case "E_BROWSE_PROVIDER_RATE_LIMITED": {
      // justify-type-assertion: the server's BrowseProviderFailure details; errors carry no generated schema.
      const { retry_at: at } = error.details as { readonly retry_at: string | null };
      const until = at === null ? null : formatDisplayDate(at, display, { hour: "numeric", minute: "2-digit", hourCycle: "h23" });
      return { reason: until === null ? "the source is limiting requests." : `the source is limiting requests until ${until}.`, retry: true };
    }
    case "E_BROWSE_PROVIDER_QUOTA_EXHAUSTED":
      return { reason: "nexus has used its youtube allowance.", retry: false };
    default:
      return null;
  }
}
