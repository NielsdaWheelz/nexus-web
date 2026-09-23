// The writable-destination wire contract the library chooser and the extension
// popup share: the destination row, its selection projection, the search page,
// the strict page decoder, and the defect a malformed same-system page raises.
// It depends on nothing but the validation primitives, so the extension bundle
// carries it without the web transport.

import { isRecord } from "@/lib/validation";

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
  if (!isRecord(raw) || !Array.isArray(raw.data) || !isRecord(raw.page)) {
    return invalidDestinationResponse(
      "search payload must contain data and page objects",
    );
  }

  const hasMore = raw.page.has_more;
  const nextCursor = raw.page.next_cursor;
  if (typeof hasMore !== "boolean") {
    return invalidDestinationResponse("page.has_more must be a boolean");
  }
  if (
    nextCursor !== null &&
    (typeof nextCursor !== "string" || nextCursor.length === 0)
  ) {
    return invalidDestinationResponse(
      "page.next_cursor must be a non-empty string or null",
    );
  }
  if (hasMore !== (nextCursor !== null)) {
    return invalidDestinationResponse(
      "page.has_more must agree with page.next_cursor",
    );
  }

  return {
    data: raw.data.map((value, index) =>
      decodeLibraryDestination(value, `data[${index}]`),
    ),
    page: { has_more: hasMore, next_cursor: nextCursor },
  };
}

function decodeLibraryDestination(
  raw: unknown,
  field: string,
): LibraryDestination {
  if (!isRecord(raw)) {
    return invalidDestinationResponse(`${field} must be an object`);
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    return invalidDestinationResponse(`${field}.id must be a non-empty string`);
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    return invalidDestinationResponse(
      `${field}.name must be a non-empty string`,
    );
  }
  if (typeof raw.created_at !== "string" || raw.created_at.length === 0) {
    return invalidDestinationResponse(
      `${field}.created_at must be a non-empty string`,
    );
  }
  if (typeof raw.updated_at !== "string" || raw.updated_at.length === 0) {
    return invalidDestinationResponse(
      `${field}.updated_at must be a non-empty string`,
    );
  }
  return {
    id: raw.id,
    name: raw.name,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

function invalidDestinationResponse(message: string): never {
  throw new LibraryDestinationContractDefect(
    `Invalid library destination response: ${message}.`,
  );
}
