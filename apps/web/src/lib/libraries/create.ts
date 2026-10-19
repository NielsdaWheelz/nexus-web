// Library creation (docs/modules/library.md): one frozen `{id, name}` per attempt;
// resending the same id answers that library, so an unknown outcome is retried
// under the same id and never under a new one. The pane dialog, form destinations
// and "Libraries…" own their attempts' lifetimes; this module decides what an
// answer means. The name rule is `libraryNameError` (views).

import type { FeedbackContent } from "@/components/feedback/Feedback";
import { isRefusal, type ApiError } from "@/lib/api/client";
import { createLibrary, type Library } from "@/lib/libraries/api";

const DEADLINE_MS = 30_000;
/** An unknown outcome with no transport copy of its own: the deadline passed. */
export const CREATION_UNCONFIRMED: FeedbackContent = {
  tone: "Warning",
  title: "library creation wasn’t confirmed",
  message: "check your connection, then retry this creation.",
};

export interface CreationAttempt {
  readonly id: string;
  readonly name: string;
}
export type CreationOutcome =
  | { readonly kind: "Created"; readonly library: Library }
  /** It never landed: the attempt ends and the name can be fixed. */
  | { readonly kind: "Refused"; readonly error: ApiError }
  /** It may have landed: only a resend of this attempt is safe. */
  | { readonly kind: "Unknown"; readonly error: unknown };

export async function sendCreation(
  attempt: CreationAttempt,
): Promise<CreationOutcome> {
  try {
    const library = await createLibrary(
      { id: attempt.id, name: attempt.name },
      AbortSignal.timeout(DEADLINE_MS),
    );
    return { kind: "Created", library };
  } catch (error) {
    return isRefusal(error)
      ? { kind: "Refused", error }
      : { kind: "Unknown", error };
  }
}
