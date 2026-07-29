import { ApiError } from "@/lib/api/client";
import {
  decodePresence,
  type Presence,
} from "@/lib/api/presence";
import {
  expectArray,
  expectExactRecord,
  expectNonnegativeInteger,
  expectString,
} from "@/lib/validation";

declare const collectionCursorBrand: unique symbol;
declare const collectionRevisionBrand: unique symbol;

export type CollectionCursor = string & {
  readonly [collectionCursorBrand]: true;
};

export type CollectionRevision = number & {
  readonly [collectionRevisionBrand]: true;
};

export interface CollectionPage<T> {
  readonly items: readonly T[];
  readonly collectionRevision: CollectionRevision;
  readonly nextCursor: Presence<CollectionCursor>;
}

function invalidCollectionPage(message: string): never {
  throw new ApiError(200, "E_INVALID_RESPONSE", message);
}

function decodeCollectionCursor(raw: unknown): CollectionCursor {
  const cursor = expectString(raw, "CollectionPage.data.nextCursor.value");
  if (cursor.length === 0) {
    return invalidCollectionPage(
      "CollectionPage.data.nextCursor.value must not be empty",
    );
  }
  return cursor as CollectionCursor;
}

export function decodeCollectionRevision(raw: unknown): CollectionRevision {
  const revision = expectNonnegativeInteger(
    raw,
    "CollectionPage.data.collectionRevision",
  );
  if (!Number.isSafeInteger(revision)) {
    return invalidCollectionPage(
      "CollectionPage.data.collectionRevision must be a safe integer",
    );
  }
  return revision as CollectionRevision;
}

export function decodeCollectionRevisionOut(raw: unknown): CollectionRevision {
  try {
    const envelope = expectExactRecord(raw, ["data"], "CollectionRevisionOut");
    const data = expectExactRecord(
      envelope.data,
      ["collectionRevision"],
      "CollectionRevisionOut.data",
    );
    return decodeCollectionRevision(data.collectionRevision);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    return invalidCollectionPage(
      error instanceof Error ? error.message : "Invalid CollectionRevisionOut",
    );
  }
}

/**
 * Strict same-system decoder for the complete-collection page envelope.
 * Presence remains owned on the browser side; omission and null are defects.
 */
export function decodeCollectionPage<T>(
  raw: unknown,
  decodeItem: (raw: unknown, index: number) => T,
): CollectionPage<T> {
  try {
    const envelope = expectExactRecord(raw, ["data"], "CollectionPage");
    const data = expectExactRecord(
      envelope.data,
      ["items", "collectionRevision", "nextCursor"],
      "CollectionPage.data",
    );
    return {
      items: expectArray(
        data.items,
        decodeItem,
        "CollectionPage.data.items",
      ),
      collectionRevision: decodeCollectionRevision(data.collectionRevision),
      nextCursor: decodePresence(data.nextCursor, decodeCollectionCursor),
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    return invalidCollectionPage(
      error instanceof Error ? error.message : "Invalid CollectionPage",
    );
  }
}
