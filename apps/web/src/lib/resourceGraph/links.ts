/**
 * User-authored Link mutation client. Mirrors `nexus/schemas/resource_graph.py`
 * (CreateLinkRequest/CreateLinkOut, PutLinkNoteRequest/LinkNoteOut); refs travel
 * as `<scheme>:<uuid>` strings. `client_mutation_id` is minted here at the call
 * boundary via the canonical id helper so a network retry replays idempotently.
 */

import type { ApiPath } from "@/lib/api/client";
import { apiFetch } from "@/lib/api/client";
import { createRandomId } from "@/lib/createRandomId";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import type { ConnectionOut } from "./connections";

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
  | LinkResourceSource
  | LinkFragmentSelectionSource
  | LinkPdfSelectionSource;

export interface LinkResourceTarget {
  kind: "resource";
  ref: string;
}

export interface LinkPassageTarget {
  kind: "passage";
  candidate_ref: string;
}

export type LinkTarget = LinkResourceTarget | LinkPassageTarget;

export interface CreateLinkInput {
  source: LinkSource;
  target: LinkTarget;
}

export interface CreateLinkOut {
  created: boolean;
  created_source_ref: string | null;
  connection: ConnectionOut;
}

interface CreateLinkResponse {
  data: CreateLinkOut;
}

export async function createLink(input: CreateLinkInput): Promise<CreateLinkOut> {
  const response = await apiFetch<CreateLinkResponse>("/api/resource-graph/links", {
    method: "POST",
    body: JSON.stringify({
      client_mutation_id: createRandomId("link"),
      source: input.source,
      target: input.target,
    }),
  });
  return response.data;
}

export async function deleteLink(linkId: string): Promise<void> {
  await apiFetch(`/api/resource-graph/links/${linkId}` as ApiPath, {
    method: "DELETE",
  });
}

export interface PutLinkNoteInput {
  noteBlockId: string;
  bodyPmJson: Record<string, unknown>;
}

export interface LinkNoteOut {
  note_block_id: string;
  connection: ConnectionOut;
}

interface LinkNoteResponse {
  data: LinkNoteOut;
}

export async function putLinkNote(
  linkId: string,
  body: PutLinkNoteInput,
): Promise<LinkNoteOut> {
  const response = await apiFetch<LinkNoteResponse>(
    `/api/resource-graph/links/${linkId}/note` as ApiPath,
    {
      method: "PUT",
      body: JSON.stringify({
        client_mutation_id: createRandomId("link-note"),
        note_block_id: body.noteBlockId,
        body_pm_json: body.bodyPmJson,
      }),
    },
  );
  return response.data;
}

export async function deleteLinkNote(linkId: string): Promise<void> {
  await apiFetch(`/api/resource-graph/links/${linkId}/note` as ApiPath, {
    method: "DELETE",
  });
}
