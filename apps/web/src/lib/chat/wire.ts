import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  apiTransportFeedback,
  isApiError,
  isChatReloadRequired,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";

// Chat's names for the generated FastAPI wire (docs/local-rules/typed-wire.md).
export type Message = Schema<"MessageOut">;
export type Conversation = Schema<"ConversationOut">;
export type RunRead = ApiJson<"/chat-runs/{run_id}", "get">["data"];
export type Receipt = ApiJson<"/chat-runs", "post">["data"];
type Outcome = Receipt["outcome"];
export type AcceptedReceipt = Receipt & {
  outcome: Extract<Outcome, { kind: "Accepted" }>;
};
export type RejectionCode = Extract<
  Outcome,
  { kind: "Rejected" }
>["reason"]["code"];
export type RunCreateRequest = Schema<"ChatRunCreateRequest">;
export type Selection =
  Schema<"CodexPersonalSelection"> | Schema<"ProviderApiSelection">;
export type Catalog = ApiJson<"/llm-catalog", "get">["data"];
export type Execution = Schema<"ChatRunExecutionOut">;
export type BranchAnchor =
  | Schema<"AssistantMessageBranchAnchorRequest">
  | Schema<"AssistantSelectionBranchAnchorRequest">;

/** Where a failed chat call goes. Total over ApiError: nothing here throws. */
export type ChatFailure =
  | { kind: "Handled" } // the auth boundary took it
  | { kind: "Reload"; requestId: string } // this tab speaks an old contract
  | { kind: "Defect"; error: unknown } // thrown in render by its owner
  | { kind: "Feedback"; feedback: FeedbackContent; ambiguous: boolean };

const AMBIGUOUS = new Set([
  "E_NETWORK",
  "E_UPSTREAM",
  "E_UPSTREAM_TIMEOUT",
  "E_GENERATION_RUNTIME_UNAVAILABLE",
]);
const GONE = "It’s no longer available.";
const MODELS = "Model availability changed. Choose a current model.";
const TARGET = "The reply target changed. Choose a response and send again.";
const UNQUOTABLE = "This passage can’t be quoted. Remove it to continue.";
// One copy owner for http failures and modeled send rejections alike.
const DETAIL: Record<string, string> = {
  E_NOT_FOUND: GONE,
  E_CONVERSATION_NOT_FOUND: GONE,
  E_MESSAGE_NOT_FOUND: GONE,
  E_FORBIDDEN: "You don’t have access to it.",
  E_CATALOG_DEFINITION_STALE: MODELS,
  E_GENERATION_SELECTION_UNAVAILABLE: MODELS,
  E_INVALID_GENERATION_SELECTION: MODELS,
  E_GENERATION_CONTEXT_TOO_LARGE:
    "This conversation no longer fits the model’s context window. Start a new chat or choose a larger model.",
  E_MESSAGE_TOO_LONG: "The message is too long. Shorten it and send again.",
  E_BRANCH_PATH_INVALID: TARGET,
  E_BRANCH_ANCHOR_INVALID: TARGET,
  E_READER_SELECTION_STALE:
    "The quoted passage changed. Review the refreshed quote and send again.",
  E_READER_SELECTION_NOT_FOUND: UNQUOTABLE,
  E_READER_SELECTION_FORBIDDEN: UNQUOTABLE,
  E_READER_SELECTION_GEOMETRY_ONLY: UNQUOTABLE,
  E_READER_SELECTION_TOO_LARGE: UNQUOTABLE,
  E_CONVERSATION_NO_LONGER_EMPTY:
    "This chat already has messages. Review them and send again.",
};
export const failureDetail = (code: string) =>
  DETAIL[code] ?? "Please try again.";

export function chatFailure(error: unknown, title: string): ChatFailure {
  if (handleUnauthenticatedApiError(error)) return { kind: "Handled" };
  if (isChatReloadRequired(error))
    return { kind: "Reload", requestId: error.requestId ?? "" };
  if (!isApiError(error) || isSameSystemApiDefect(error))
    return { kind: "Defect", error };
  const feedback = apiTransportFeedback(error, title) ?? {
    tone: "Danger",
    title,
    message: failureDetail(error.code),
    requestId: error.requestId,
  };
  return {
    kind: "Feedback",
    feedback,
    ambiguous: AMBIGUOUS.has(error.code) || error.status >= 500,
  };
}
