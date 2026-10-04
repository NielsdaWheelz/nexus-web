import type { ApiJson, Schema } from "@/lib/api/wire";
import {
  decodeCollectionCursor,
  decodeCollectionRevision,
  type CollectionPage,
} from "@/lib/api/collectionPage";
import { absent, present } from "@/lib/api/presence";

export type LibraryOut = Schema<"LibraryOut">;
export type LibraryMember = Schema<"LibraryMemberOut">;
export type LibraryInvitation = Schema<"LibraryInvitationOut">;
export type ViewerLibraryInvitation = Schema<"ViewerLibraryInvitationOut">;
export type LibraryRole = LibraryMember["role"];
export type LibraryInvitationStatus = LibraryInvitation["status"];
export type LibraryGovernanceCursor = Extract<
  Schema<"LibraryGovernancePageInfo">["nextCursor"],
  { kind: "Present" }
>["value"];
export type LibraryGovernancePageInfo = Schema<"LibraryGovernancePageInfo">;
export type LibraryGovernancePage<T> = Omit<
  ApiJson<"/libraries/{library_id}/members", "get">,
  "data"
> & { data: T[] };

export class LibraryContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: a mismatched library identity or scope is a same-system
    // contract defect, not a modeled user failure.
    super(message);
    this.name = "LibraryContractDefect";
  }
}

export function isLibraryContractDefect(
  error: unknown,
): error is LibraryContractDefect {
  return error instanceof LibraryContractDefect;
}

export function libraryOutForId(
  library: LibraryOut,
  requestedId: string,
  name = "LibraryOut",
): LibraryOut {
  if (library.id !== requestedId) {
    throw new LibraryContractDefect(
      `${name}.id ${JSON.stringify(library.id)} does not match requested Library ${JSON.stringify(requestedId)}`,
    );
  }
  return library;
}

export function librariesPageFromWire(
  page: ApiJson<"/libraries", "get">["data"],
): CollectionPage<LibraryOut> {
  return {
    items: page.items,
    collectionRevision: decodeCollectionRevision(page.collectionRevision),
    nextCursor: page.nextCursor.kind === "Present"
      ? present(decodeCollectionCursor(page.nextCursor.value))
      : absent(),
  };
}
