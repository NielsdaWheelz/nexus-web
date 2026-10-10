import { ApiError } from "@/lib/api/client";
import { absent, type Presence } from "@/lib/api/presence";
import { expectNonnegativeInteger, expectString } from "@/lib/validation";

declare const collectionCursorBrand: unique symbol;
declare const collectionRevisionBrand: unique symbol;

export type CollectionCursor = string & {
  readonly [collectionCursorBrand]: true;
};

export type CollectionRevision = number & {
  readonly [collectionRevisionBrand]: true;
};

export const NO_CURSOR = absent<CollectionCursor>();
export const ZERO_REVISION = 0 as CollectionRevision;

export interface CollectionPage<T> {
  readonly items: readonly T[];
  readonly collectionRevision: CollectionRevision;
  readonly nextCursor: Presence<CollectionCursor>;
}

function invalidCollectionPage(message: string): never {
  throw new ApiError(200, "E_INVALID_RESPONSE", message);
}

export function decodeCollectionCursor(raw: unknown): CollectionCursor {
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
