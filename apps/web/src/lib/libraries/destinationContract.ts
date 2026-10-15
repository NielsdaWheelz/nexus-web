// destination wire types are generated; runtime decoding remains for independently
// deployed extension responses and persisted selections.

import type { ApiJson, Schema } from "@/lib/api/wire";

import {
  expectArray,
  expectCanonicalRfcUuid,
  expectExactRecord,
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

export type LibraryDestinationSelection = Schema<"LibraryIdentityOut">;

/** Decodes a selection that crossed a boundary as exactly `{id, name}`. Like
    the validation primitives it raises TypeError, which the caller owns. */
export function decodeLibraryDestinationSelection(
  raw: unknown,
  name: string,
): LibraryDestinationSelection {
  const selection = expectExactRecord(raw, ["id", "name"], name);
  return {
    id: expectCanonicalRfcUuid(selection.id, `${name}.id`),
    name: expectNonemptyString(selection.name, `${name}.name`),
  };
}

export type LibraryDestinationCatalog = ApiJson<"/libraries/writable-destinations", "get">;

export function decodeWritableLibraryDestinationCatalog(
  raw: unknown,
): LibraryDestinationCatalog {
  // The validation primitives raise TypeError, which isLibraryDestinationDefect
  // reads as a network failure; every decode failure here is a same-system
  // contract defect instead.
  try {
    const envelope = expectExactRecord(raw, ["data"], "catalog payload");
    return {
      data: expectArray(
        envelope.data,
        (value, index) => decodeLibraryDestinationSelection(value, `data[${index}]`),
        "data",
      ),
    };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new LibraryDestinationContractDefect(
      `Invalid library destination response: ${error.message}.`,
    );
  }
}
