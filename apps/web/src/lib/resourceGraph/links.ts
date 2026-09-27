/**
 * User-authored Link mutation client. Mirrors `nexus/schemas/resource_graph.py`
 * (CreateLinkRequest/CreateLinkOut, PutLinkNoteRequest/LinkNoteOut); refs travel
 * as `<scheme>:<uuid>` strings. The confirming feature freezes
 * `client_mutation_id` with its intent so every retry replays idempotently.
 */

import type { ApiPath } from "@/lib/api/client";
import { apiFetch } from "@/lib/api/client";
import { decodeNoteBodyValue } from "@/lib/notes/prosemirror/schema";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import type { ResourceTarget } from "@/lib/resources/resourceTargets";
import { decodeConnectionOut, type ConnectionOut } from "./connections";
import {
  expectBoolean,
  expectExactRecord,
  expectFiniteNumber,
  expectNullableString,
  expectString,
} from "@/lib/validation";

export interface LinkResourceSource {
  kind: "resource";
  ref: string;
}

export interface LinkFragmentSelectionSource {
  kind: "fragment_selection";
  highlight_id: string;
  fragment_id: string;
  start_offset: number;
  end_offset: number;
  color: HighlightColor;
}

export interface LinkPdfSelectionSource {
  kind: "pdf_selection";
  highlight_id: string;
  media_id: string;
  page_number: number;
  quads: PdfHighlightQuad[];
  exact: string;
  color: HighlightColor;
}

export type LinkSource =
  LinkResourceSource | LinkFragmentSelectionSource | LinkPdfSelectionSource;

export interface LinkResourceTarget {
  kind: "resource";
  ref: string;
}

export interface LinkPassageTarget {
  kind: "passage";
  candidate_ref: string;
}

export type LinkTarget = LinkResourceTarget | LinkPassageTarget;

export function toLinkTarget(target: ResourceTarget): LinkTarget {
  return target.kind === "resource"
    ? { kind: "resource", ref: target.item.ref }
    : { kind: "passage", candidate_ref: target.candidateRef };
}

export function targetLabel(target: ResourceTarget): string {
  return target.kind === "resource" ? target.item.label : target.label;
}

export interface CreateLinkInput {
  clientMutationId: string;
  source: LinkSource;
  target: LinkTarget;
}

export interface CreateLinkOut {
  created: boolean;
  created_source_ref: string | null;
  connection: ConnectionOut;
}

export async function createLink(
  input: CreateLinkInput,
): Promise<CreateLinkOut> {
  const response = await apiFetch<{ data: unknown }>(
    "/api/resource-graph/links",
    {
      method: "POST",
      body: JSON.stringify({
        client_mutation_id: input.clientMutationId,
        source: input.source,
        target: input.target,
      }),
    },
  );
  const value = expectExactRecord(
    response.data,
    ["created", "created_source_ref", "connection"],
    "CreateLinkOut",
  );
  return {
    created: expectBoolean(value.created, "CreateLinkOut.created"),
    created_source_ref: expectNullableString(
      value.created_source_ref,
      "CreateLinkOut.created_source_ref",
    ),
    connection: decodeConnectionOut(
      value.connection,
      "CreateLinkOut.connection",
    ),
  };
}

export async function deleteLink(linkId: string): Promise<void> {
  await apiFetch(`/api/resource-graph/links/${linkId}` as ApiPath, {
    method: "DELETE",
  });
}

export interface LinkNoteOut {
  note_block_id: string;
  body_pm_json: Record<string, unknown>;
  body_text: string;
  version_by_lane: { body: number; outgoing_edges: number };
  connection: ConnectionOut;
}

export function decodeLinkNoteOut(raw: unknown): LinkNoteOut {
  const value = expectExactRecord(
    raw,
    ["note_block_id", "body_pm_json", "body_text", "version_by_lane", "connection"],
    "LinkNoteOut",
  );
  const noteBody = decodeNoteBodyValue(value.body_pm_json, value.body_text, "LinkNoteOut");
  const versions = expectExactRecord(
    value.version_by_lane,
    ["body", "outgoing_edges"],
    "LinkNoteOut.version_by_lane",
  );
  const bodyVersion = expectFiniteNumber(versions.body, "LinkNoteOut.version_by_lane.body");
  const edgeVersion = expectFiniteNumber(versions.outgoing_edges, "LinkNoteOut.version_by_lane.outgoing_edges");
  if (!Number.isInteger(bodyVersion) || bodyVersion < 1 || !Number.isInteger(edgeVersion) || edgeVersion < 0) {
    throw new TypeError("LinkNoteOut.version_by_lane is invalid");
  }
  return {
    note_block_id: expectString(value.note_block_id, "LinkNoteOut.note_block_id"),
    body_pm_json: noteBody.bodyPmJson,
    body_text: noteBody.bodyText,
    version_by_lane: { body: bodyVersion, outgoing_edges: edgeVersion },
    connection: decodeConnectionOut(value.connection, "LinkNoteOut.connection"),
  };
}
