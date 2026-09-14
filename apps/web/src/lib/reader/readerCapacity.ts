/**
 * UNQUALIFIED experiment inputs. Release requires maximum-workload browser
 * receipts for this exact profile; payload reservations are not JS/Blink heap.
 */
export const READER_CAPACITY = {
  descriptorBytes: 16 * 1_024,
  indexBytes: 256 * 1_024,
  unitBytes: 256 * 1_024,
  unitCodePoints: 65_536,
  unitDomNodes: 8_192,
  cache: { maxPayloadBytes: 32 * 1_024 * 1_024, maxReads: 2, reservedViewReads: 1 },
  // Content residency and query/decoration leases are separate pools: the
  // reader window keeps one neighbour each way and admits a replacement before
  // retiring the previous window (4 units), and every resident unit carries a
  // highlight paint and an embed lease (2 each) beside the eight view queries
  // that can stand at once (contents index, find result, gutter window,
  // document-map overview, one bucket page, one marker preview, one apparatus
  // lookup, one addressed location).
  view: { maxPayloadBytes: 8 * 1_024 * 1_024, maxUnits: 4, maxQueryLeases: 16, maxDomNodes: 16_384 },
} as const;

/**
 * Wire bytes reserve the buffer (1x), the decoded JSON string (<=2x), the
 * parsed primitive values (<=4x) and the typed decoder's mapped primitive
 * values (<=4x). JSON arrays need >=2 wire bytes per 8-byte number and strings
 * need <=2x. Object/array headers and DOM are separate qualification costs.
 */
export const READER_DECODE_RESERVATION_FACTOR = 11;
/** The settled primitive payload a decoded member may actually retain. */
export const READER_RETAINED_PAYLOAD_FACTOR = 4;

export interface ReaderCapacity {
  readonly descriptorBytes: number;
  readonly indexBytes: number;
  readonly unitBytes: number;
  readonly unitCodePoints: number;
  readonly unitDomNodes: number;
  readonly cache: { readonly maxPayloadBytes: number; readonly maxReads: number; readonly reservedViewReads: number };
  readonly view: { readonly maxPayloadBytes: number; readonly maxUnits: number; readonly maxQueryLeases: number; readonly maxDomNodes: number };
}

/** Why a reader refused work it is otherwise able to perform. */
export type ReaderCapacityReason = "Payload" | "Reads" | "Leases" | "Dom" | "Pins" | "Content";

/**
 * `Content` is the API's terminal oversize refusal (422
 * `E_READER_CONTENT_TOO_LARGE`): permanent for this publication generation
 * under the qualified profile, so no surface may offer a retry for it.
 */
export function readerCapacityNotice(reason: ReaderCapacityReason): { readonly message: string; readonly retryable: boolean } {
  return reason === "Content"
    ? { message: "This document exceeds the supported size for this reader.", retryable: false }
    : { message: "The reader is waiting for space. Release the selection or close unused reader content, then retry.", retryable: true };
}
