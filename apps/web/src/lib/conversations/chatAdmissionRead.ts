import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import { decodeChatRunResponse } from "./messageWire";
import type { ChatRunResponse } from "./types";
import type { AcceptedChatAdmission } from "./chatAdmission";

/** Read recovery after acknowledgment never invokes admission. */
export async function readAdmittedChatRun(
  receipt: AcceptedChatAdmission,
): Promise<ChatRunResponse["data"]> {
  const response = await apiFetch<unknown>(
    `/api/chat-runs/${receipt.outcome.run_id}`,
  );
  return decodeApiPayload(
    response,
    () => {
      const data = decodeChatRunResponse(response).data;
      const target = receipt.outcome;
      if (
        data.run.id !== target.run_id ||
        data.run.conversation_id !== target.conversation_id ||
        data.conversation.id !== target.conversation_id ||
        data.assistant_message.id !== target.assistant_message_id ||
        data.run.assistant_message_id !== target.assistant_message_id
      )
        throw new Error("Acknowledged chat read identity mismatch");
      return data;
    },
    "Acknowledged chat read",
  );
}
