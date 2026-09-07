/**
 * The one place chat-failure copy is authored. `chatFailureMessage` maps every
 * `ExpectedChatFailure` variant — plus the `null` case (a running/healthy
 * message, or an unrepresentable defect with no stored closed code) — to a quiet, concise,
 * product-facing `{ title, body }` pair.
 *
 * The switch is exhaustive over `code`: adding a variant to the backend
 * union without updating this file is a COMPILE error (see the `never`
 * default), not a silent fallback to generic copy.
 *
 * Copy rules (§10): never leak provider names, HTTP status text, stack
 * traces, or raw error codes. Never state or imply a cause the platform
 * cannot stand behind. Rendering the returned `{ title, body }` (whether to
 * rerun, what support_id to show) is the caller's job — see
 * `ChatFailureCard.tsx`.
 */

import type { ExpectedChatFailure } from "@/lib/conversations/types";

export interface ChatFailureMessage {
  title: string;
  body: string;
}

function unsupportedChatFailure(failure: never): never {
  const code = (failure as { code?: unknown }).code;
  throw new Error(`Unsupported chat failure code: ${JSON.stringify(code)}`);
}

/** The generic, non-rerunnable card shown for an operator defect or when the
 * run/message has no representable stored failure code. */
const GENERIC_DEFECT_MESSAGE: ChatFailureMessage = {
  title: "Something went wrong",
  body: "This response couldn't be completed. Please try again in a new message.",
};

export function chatFailureMessage(
  failure: ExpectedChatFailure | null,
): ChatFailureMessage {
  if (failure === null) {
    return GENERIC_DEFECT_MESSAGE;
  }

  switch (failure.code) {
    case "cancelled":
      return {
        title: "Cancelled",
        body: "This response was cancelled.",
      };
    case "context_too_large":
      return {
        title: "Conversation too large",
        body: "This conversation has grown too large to process. Start a new conversation or branch from an earlier point.",
      };
    case "invalid_output":
      return {
        title: "Invalid response",
        body: "The assistant returned an invalid response. Please try again.",
      };
    case "incomplete":
      return {
        title: "Response incomplete",
        body: "The response ended before it was finished.",
      };
    case "assistant_unavailable":
      return {
        title: "Assistant unavailable",
        body: "The assistant is temporarily unavailable. Please try again shortly.",
      };
    case "operator_defect":
      return GENERIC_DEFECT_MESSAGE;
    default:
      // Exhaustiveness guard: if a variant is added to ExpectedChatFailure
      // without a case above, this line fails to compile.
      return unsupportedChatFailure(failure);
  }
}
