import { createRandomId } from "@/lib/createRandomId";

// Shared client-mutation-id intent (spec §7), reused by the edit-authors editor and
// the rename dialog. One rule for both:
//
//  - reuse the SAME id while the payload is unchanged, so a transport-uncertain
//    retry replays idempotently server-side (never rotate on a transport failure);
//  - rotate to a fresh id when the payload changes, or on a proven 409 replay
//    mismatch (the reused key is now bound to a different request server-side);
//  - discard on success or cancel — the next attempt mints a fresh id.
//
// The intent is keyed by an opaque, caller-computed payload key (e.g. a stable
// serialization of the ordered author rows, or the cleaned rename target). The
// helper never inspects the key beyond equality.

export interface MutationIntent {
  /**
   * The client-mutation-id for the given payload key. Mints a fresh id when there
   * is no current id or the payload key differs from the last one; otherwise
   * returns the same id so retries of an unchanged payload reuse the key.
   */
  clientMutationId: (payloadKey: string) => string;
  /** The reused key is no longer usable (payload changed, or proven 409 mismatch): next call mints fresh. */
  rotate: () => void;
  /** The operation finished (success/cancel): forget the current id. */
  discard: () => void;
}

export function createMutationIntent(generateId: () => string = createRandomId): MutationIntent {
  let currentId: string | null = null;
  let currentKey: string | null = null;

  const reset = () => {
    currentId = null;
    currentKey = null;
  };

  return {
    clientMutationId(payloadKey: string): string {
      if (currentId === null || currentKey !== payloadKey) {
        currentId = generateId();
        currentKey = payloadKey;
      }
      return currentId;
    },
    rotate: reset,
    discard: reset,
  };
}
