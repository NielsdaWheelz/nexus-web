import { createRandomId } from "@/lib/createRandomId";

// A client mutation id for one intended payload (metadata research admission):
//
//  - reuse the SAME id while the payload is unchanged, so a transport-uncertain
//    retry replays idempotently server-side (never rotate on a transport failure);
//  - mint a fresh id when the payload changes;
//  - discard on success or a rejection: the next attempt mints a fresh id.
//
// The payload key is opaque and caller-computed; only its equality matters.

export interface MutationIntent {
  /** The id for this payload key: the current one while the key is unchanged. */
  clientMutationId: (payloadKey: string) => string;
  /** Forget the current id: the next call mints a fresh one. */
  discard: () => void;
}

export function createMutationIntent(
  generateId: () => string = createRandomId,
): MutationIntent {
  let currentId: string | null = null;
  let currentKey: string | null = null;
  return {
    clientMutationId(payloadKey: string): string {
      if (currentId === null || currentKey !== payloadKey) {
        currentId = generateId();
        currentKey = payloadKey;
      }
      return currentId;
    },
    discard() {
      currentId = null;
      currentKey = null;
    },
  };
}
