import { CHAT_CONTRACT_HEADER, CHAT_CONTRACT_REVISION, TOOL_PROJECTION_HEADER } from "./client";
import { TOOL_PROJECTION_REVISION } from "@/lib/chat/toolContractProjection";
import { sseClientDirect } from "./sse-client";

type GenerationRunKind = "chat-runs" | "media";

/**
 * Stream path prefix per run kind, joined as `${prefix}/${id}/events` under
 * the stream base URL. Both browser-callable generation-run SSE
 * endpoints live under `/stream/` (one prefix predicate guards the
 * bearer-auth boundary).
 */
const GENERATION_RUN_STREAM_PATHS: Record<GenerationRunKind, string> = {
  "chat-runs": "/stream/chat-runs",
  media: "/stream/media",
};

/**
 * Open one SSE subscription to a generation run: the per-kind stream path and
 * contract headers handed to `sseClientDirect`. Chat's run tailer and media
 * processing status both open their runs here. The caller owns the stream
 * lifecycle callbacks/options. Run identities are encoded at this owner before
 * entering the path.
 */
export async function openGenerationRunStream<TEvent>(
  kind: GenerationRunKind,
  id: string,
  sseArgs: Omit<Parameters<typeof sseClientDirect<TEvent>>[0], "path">,
): Promise<() => void> {
  return sseClientDirect<TEvent>({
    ...sseArgs,
    path: `${GENERATION_RUN_STREAM_PATHS[kind]}/${encodeURIComponent(id)}/events`,
    requestHeaders:
      kind === "chat-runs"
        ? { [TOOL_PROJECTION_HEADER]: TOOL_PROJECTION_REVISION, [CHAT_CONTRACT_HEADER]: CHAT_CONTRACT_REVISION }
        : undefined,
  });
}
