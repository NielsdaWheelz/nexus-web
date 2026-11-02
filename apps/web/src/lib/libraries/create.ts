// Library creation (docs/modules/library.md): one frozen `{id, name, initial_items, expected_removal_revision}` per attempt;
// resending the same id answers that library, so an unknown outcome is retried
// under the same id and never under a new one. The pane dialog, form destinations
// and "Libraries…" own their attempts' lifetimes; this module decides what an
// answer means: only a sent attempt can be unknown. The name rule is `libraryNameError`
// (views).

import { admissionRefusal, isRefusal, type ApiError } from "@/lib/api/client";
import { createLibrary, type Library } from "@/lib/libraries/api";
import { remoteAttemptAllowed } from "@/lib/native/admission";

const DEADLINE_MS = 30_000;

interface CreationAttempt {
  readonly id: string;
  readonly name: string;
  readonly initial_items: readonly string[];
  readonly expected_removal_revision: string | null;
}
type CreationOutcome =
  | { readonly kind: "Created"; readonly library: Library }
  /** It never landed: the attempt ends and the name can be fixed. */
  | { readonly kind: "Refused"; readonly error: ApiError }
  /** It may have landed: only a resend of this attempt is safe. */
  | { readonly kind: "Unknown"; readonly error: unknown };

export async function sendCreation(
  attempt: CreationAttempt,
): Promise<CreationOutcome> {
  // What apiFetch would refuse unsent in this same tick never landed.
  if (!remoteAttemptAllowed()) return { kind: "Refused", error: admissionRefusal() };
  try {
    const library = await createLibrary(
      { id: attempt.id, name: attempt.name, initial_items: [...attempt.initial_items], expected_removal_revision: attempt.expected_removal_revision },
      AbortSignal.timeout(DEADLINE_MS),
    );
    return { kind: "Created", library };
  } catch (error) {
    return isRefusal(error)
      ? { kind: "Refused", error }
      : { kind: "Unknown", error };
  }
}
