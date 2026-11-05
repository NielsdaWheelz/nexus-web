
import type { Line } from "@/components/feedback/stage";
import { isApiError, isSameSystemApiDefect, outcomeUnknown, type ApiError } from "@/lib/api/client";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { MODEL_UNAVAILABLE } from "./selection";

// Chat's names for the generated FastAPI wire (docs/local-rules/typed-wire.md).
export type Message = Schema<"MessageOut">;
export type Conversation = Schema<"ConversationOut">;
export type RunRead = ApiJson<"/chat-runs/{run_id}", "get">["data"];
/** Create and repeat answer the same receipt. */
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
  | Schema<"AssistantMessageBranchAnchor">
  | Schema<"AssistantSelectionBranchAnchor">;

/** A failed chat call, by what its owner does next. Total over thrown values: nothing here throws. */
export type ChatFailure =
  | { kind: "Handled" } // the sign-in boundary took it
  | { kind: "Defect"; error: unknown } // its owner throws it to the render boundary
  | { kind: "Refused"; error: ApiError } // answered: nothing changed
  | { kind: "Unknown"; error: ApiError }; // unanswered: a write may have landed

/** Reads have no write outcome. A handled sign-in or defect follows the same boundary contract. */
export function readFailureOf(error: unknown): { kind: "Handled" } | { kind: "Defect"; error: unknown } | { kind: "Failed"; error: ApiError } {
  if (handleUnauthenticatedApiError(error)) return { kind: "Handled" };
  if (!isApiError(error) || isSameSystemApiDefect(error)) return { kind: "Defect", error };
  return { kind: "Failed", error };
}

export function failureOf(error: unknown): ChatFailure {
  const failure = readFailureOf(error);
  if (failure.kind !== "Failed") return failure;
  // runtime readiness is checked before chat admission.
  return failure.error.code !== "E_GENERATION_RUNTIME_UNAVAILABLE" && outcomeUnknown(failure.error)
    ? { kind: "Unknown", error: failure.error } : { kind: "Refused", error: failure.error };
}

const MISSING = "it doesn’t exist.";
const UNQUOTABLE = "this passage can’t be quoted.";
/** A refusal's reason after its command's fact, by the server's code; null leaves the bare fact.
 * Closed: a server's explanation never reaches the screen. */
const REASONS: Readonly<Record<RejectionCode | "E_GENERATION_RUNTIME_UNAVAILABLE", string | null>> = {
  E_CONVERSATION_CHANGED: "this chat changed meanwhile.",
  E_CHAT_CREATION_STALE: "this send can no longer be retried.",
  E_MESSAGE_TOO_LONG: "this message is over 20,000 characters.",
  E_INVALID_GENERATION_SELECTION: MODEL_UNAVAILABLE,
  E_GENERATION_SELECTION_UNAVAILABLE: MODEL_UNAVAILABLE,
  E_GENERATION_RUNTIME_UNAVAILABLE: "the model isn’t ready.",
  E_INVALID_REQUEST: null,
  E_BRANCH_PATH_INVALID: "you can reply only to a complete answer.",
  E_BRANCH_ANCHOR_INVALID: null,
  E_FORBIDDEN: "you don’t have access.",
  E_NOT_FOUND: MISSING,
  E_CONVERSATION_NOT_FOUND: MISSING,
  E_MESSAGE_NOT_FOUND: MISSING,
  E_RETRY_NOT_ALLOWED: "this answer can’t be rerun.",
  E_REGENERATION_NOT_ALLOWED: "this answer isn’t complete.",
  E_READER_SELECTION_STALE: "the quoted passage changed.",
  E_READER_SELECTION_NOT_FOUND: UNQUOTABLE,
  E_READER_SELECTION_FORBIDDEN: UNQUOTABLE,
  E_READER_SELECTION_GEOMETRY_ONLY: UNQUOTABLE,
  E_READER_SELECTION_TOO_LARGE: UNQUOTABLE,
  E_CONVERSATION_NO_LONGER_EMPTY: "this chat has messages now.",
  E_GENERATION_CONTEXT_TOO_LARGE: "this chat is too long for this model.",
};
const isReasoned = (code: string): code is keyof typeof REASONS => code in REASONS;

/** The reader's refusal of a passage, by the same record: its sentence, or null for any other code. */
export const unquotable = (error: ApiError): string | null =>
  isReasoned(error.code) && REASONS[error.code] === UNQUOTABLE ? UNQUOTABLE : null;

/** A refused chat command as it reads. `error` is the failure whose transport gave the reason, so
 * that transport's verbs follow the line; a domain or local reason takes none. */
export type Refusal = { readonly line: Line; readonly error: ApiError | null };

/** A refusal by the server's code: the command's fact, then the domain's reason, or the bare fact. */
export function rejected(fact: string, code: keyof typeof REASONS): Refusal {
  const reason = REASONS[code];
  if (reason === undefined) throw new Error("chat rejection has no owned explanation");
  return { line: { fact, reason: reason ?? undefined }, error: null };
}

/** A thrown refusal: a domain code's reason runs ahead of the transport's. */
export const refusal = (fact: string, error: ApiError): Refusal => isReasoned(error.code)
  ? rejected(fact, error.code) : { line: TRANSPORT_LINES[transportOf(error)].command(fact), error };
