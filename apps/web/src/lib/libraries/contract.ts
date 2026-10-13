import type { ApiJson, Schema } from "@/lib/api/wire";

export type LibraryOut = Schema<"LibraryOut">;
export type LibraryMember = Schema<"LibraryMemberOut">;
export type LibraryInvitation = Schema<"LibraryInvitationOut">;
export type ViewerLibraryInvitation = Schema<"ViewerLibraryInvitationOut">;
export type LibraryRole = LibraryMember["role"];
export type LibraryInvitationStatus = LibraryInvitation["status"];
export type LibraryGovernanceCursor = NonNullable<
  Schema<"LibraryGovernancePageInfo">["next_cursor"]
>;
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
