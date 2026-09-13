/**
 * The one place chat-failure copy is authored. `chatFailureMessage` maps every
 * `ExpectedChatFailure` variant — plus the `null` case (a running/healthy
 * message, or a DEFECT with no stored closed code) — to a quiet, concise,
 * product-facing `{ title, body }` pair.
 *
 * The switch is exhaustive over `code`: adding a tenth variant to the backend
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

/** The generic, non-rerunnable card shown for a DEFECT: `failure` is null but
 * the run/message status is terminal-failed. Also used as the shape callers
 * fall back to when there is nothing more specific to say. */
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
    case "refused":
      return {
        title: "Response declined",
        body: "The assistant declined to respond to this message.",
      };
    case "incomplete":
      return {
        title: "Response incomplete",
        body: "The response ended before it was finished.",
      };
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
    case "invalid_tool_arguments":
      return {
        title: "Tool call failed",
        body: "The assistant's request to use a tool could not be processed.",
      };
    case "budget_exceeded":
      return {
        title: "Usage limit reached",
        body: "This response exceeded the available usage budget.",
      };
    case "rate_limited":
      return {
        title: "Rate limited",
        body: "The AI provider is temporarily limiting requests. Please try again shortly.",
      };
    case "timeout":
      return {
        title: "Request timed out",
        body: "The AI provider didn't respond in time. Please try again.",
      };
    case "provider_unavailable":
      return {
        title: "Provider unavailable",
        body: "The AI provider is temporarily unavailable. Please try again shortly.",
      };
    case "stream_interrupted":
      return {
        title: "Connection interrupted",
        body: "The response stream was interrupted before it finished.",
      };
    default: {
      // Exhaustiveness guard: if a variant is added to ExpectedChatFailure
      // without a case above, this line fails to compile.
      const _exhaustive: never = failure;
      return _exhaustive;
    }
  }
}
