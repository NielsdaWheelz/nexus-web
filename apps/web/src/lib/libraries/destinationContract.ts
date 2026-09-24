// The writable-destination wire contract the library chooser and the extension
// share: the destination row, its selection projection and decoder, the search
// page, the strict page decoder, and the defect a malformed same-system page
// raises.
// It depends on nothing but the validation primitives, so the extension bundle
// carries it without the web transport.

import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectIsoInstant,
  expectNonemptyString,
} from "@/lib/validation";

export class LibraryDestinationContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: malformed same-system destination payloads violate the
    // owned library picker contract and cannot be modeled as user failure.
    super(message);
    this.name = "LibraryDestinationContractDefect";
  }
}

export interface LibraryDestination {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export type LibraryDestinationSelection = Pick<LibraryDestination, "id" | "name">;

/** Decodes a selection that crossed a boundary as exactly `{id, name}`. Like
    the validation primitives it raises TypeError, which the caller owns. */
export function decodeLibraryDestinationSelection(
  raw: unknown,
  name: string,
): LibraryDestinationSelection {
  const selection = expectExactRecord(raw, ["id", "name"], name);
  return {
    id: expectNonemptyString(selection.id, `${name}.id`),
    name: expectNonemptyString(selection.name, `${name}.name`),
  };
}

export interface LibraryDestinationPage {
  data: LibraryDestination[];
  page: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

export function decodeWritableLibraryDestinationPage(
  raw: unknown,
): LibraryDestinationPage {
  // The validation primitives raise TypeError, which isLibraryDestinationDefect
  // reads as a network failure; every decode failure here is a same-system
  // contract defect instead.
  try {
    const envelope = expectExactRecord(raw, ["data", "page"], "search payload");
    const page = expectExactRecord(
      envelope.page,
      ["has_more", "next_cursor"],
      "page",
    );
    const hasMore = expectBoolean(page.has_more, "page.has_more");
    const nextCursor =
      page.next_cursor === null
        ? null
        : expectNonemptyString(page.next_cursor, "page.next_cursor");
    if (hasMore !== (nextCursor !== null)) {
      throw new TypeError("page.has_more must agree with page.next_cursor");
    }
    return {
      data: expectArray(
        envelope.data,
        (value, index) => {
          const field = `data[${index}]`;
          const row = expectExactRecord(
            value,
            ["id", "name", "created_at", "updated_at"],
            field,
          );
          return {
            id: expectNonemptyString(row.id, `${field}.id`),
            name: expectNonemptyString(row.name, `${field}.name`),
            created_at: expectIsoInstant(row.created_at, `${field}.created_at`),
            updated_at: expectIsoInstant(row.updated_at, `${field}.updated_at`),
          };
        },
        "data",
      ),
      page: { has_more: hasMore, next_cursor: nextCursor },
    };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new LibraryDestinationContractDefect(
      `Invalid library destination response: ${error.message}.`,
    );
  }
}
