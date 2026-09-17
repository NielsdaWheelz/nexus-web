import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectFiniteNumber,
  expectIsoInstant,
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";
import {
  HIGHLIGHT_COLORS,
  type HighlightColor,
} from "@/lib/highlights/segmenter";

export interface HighlightLinkedNoteBlock {
  note_block_id: string;
  // The shared PDF leaf shape remains optional; hosted text-highlight
  // responses always decode this field below.
  body_pm_json?: Record<string, unknown>;
  body_text: string;
}

export interface HighlightLinkedConversation {
  conversation_id: string;
  title: string;
}

export interface Highlight {
  id: string;
  anchor: {
    type: "fragment_offsets";
    media_id: string;
    // Disposable locator cache: null when the cached fragment row vanished
    // (reindex/refresh) and the quote no longer resolves uniquely. The
    // highlight stays visible but unresolved — it is never painted at a
    // wrong location (universal-link-authoring-hard-cutover.md, Highlight
    // Durability).
    fragment_id: string | null;
    start_offset: number | null;
    end_offset: number | null;
  };
  color: HighlightColor;
  exact: string;
  prefix: string;
  suffix: string;
  created_at: string;
  updated_at: string;
  author_user_id: string;
  is_owner: boolean;
  linked_conversations: HighlightLinkedConversation[];
  linked_note_blocks: HighlightLinkedNoteBlock[];
}

function expectInteger(raw: unknown, name: string): number {
  const value = expectFiniteNumber(raw, name);
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  return value;
}

function expectNullableInteger(raw: unknown, name: string): number | null {
  return raw === null ? null : expectInteger(raw, name);
}

function decodeLinkedConversation(
  raw: unknown,
  index: number,
): HighlightLinkedConversation {
  const name = `Highlight.linked_conversations[${index}]`;
  const value = expectExactRecord(raw, ["conversation_id", "title"], name);
  return {
    conversation_id: expectString(
      value.conversation_id,
      `${name}.conversation_id`,
    ),
    title: expectString(value.title, `${name}.title`),
  };
}

export function decodeHighlightLinkedNoteBlock(
  raw: unknown,
  name = "HighlightLinkedNoteBlock",
): HighlightLinkedNoteBlock {
  const value = expectExactRecord(
    raw,
    ["note_block_id", "body_pm_json", "body_text"],
    name,
  );
  return {
    note_block_id: expectString(value.note_block_id, `${name}.note_block_id`),
    body_pm_json: expectRecord(value.body_pm_json, `${name}.body_pm_json`),
    body_text: expectString(value.body_text, `${name}.body_text`),
  };
}

function decodeCommonHighlightFields(
  value: Record<string, unknown>,
  name: string,
) {
  return {
    id: expectString(value.id, `${name}.id`),
    color: expectOneOf(value.color, HIGHLIGHT_COLORS, `${name}.color`),
    exact: expectString(value.exact, `${name}.exact`),
    prefix: expectString(value.prefix, `${name}.prefix`),
    suffix: expectString(value.suffix, `${name}.suffix`),
    created_at: expectIsoInstant(value.created_at, `${name}.created_at`),
    updated_at: expectIsoInstant(value.updated_at, `${name}.updated_at`),
    author_user_id: expectString(
      value.author_user_id,
      `${name}.author_user_id`,
    ),
    is_owner: expectBoolean(value.is_owner, `${name}.is_owner`),
    linked_conversations: expectArray(
      value.linked_conversations,
      decodeLinkedConversation,
      `${name}.linked_conversations`,
    ),
    linked_note_blocks: expectArray(
      value.linked_note_blocks,
      (item, index) =>
        decodeHighlightLinkedNoteBlock(
          item,
          `${name}.linked_note_blocks[${index}]`,
        ),
      `${name}.linked_note_blocks`,
    ),
  };
}

const HIGHLIGHT_KEYS = [
  "id",
  "anchor",
  "color",
  "exact",
  "prefix",
  "suffix",
  "created_at",
  "updated_at",
  "author_user_id",
  "is_owner",
  "linked_conversations",
  "linked_note_blocks",
] as const;

export function decodeHighlight(raw: unknown, name = "Highlight"): Highlight {
  const value = expectExactRecord(raw, HIGHLIGHT_KEYS, name);
  const anchor = expectRecord(value.anchor, `${name}.anchor`);
  const common = decodeCommonHighlightFields(value, name);
  if (anchor.type !== "fragment_offsets") {
    throw new TypeError(`${name}.anchor.type is unsupported`);
  }
  const decodedAnchor = expectExactRecord(
    anchor,
    ["type", "media_id", "fragment_id", "start_offset", "end_offset"],
    `${name}.anchor`,
  );
  return {
    ...common,
    anchor: {
      type: "fragment_offsets",
      media_id: expectString(decodedAnchor.media_id, `${name}.anchor.media_id`),
      fragment_id: expectNullableString(
        decodedAnchor.fragment_id,
        `${name}.anchor.fragment_id`,
      ),
      start_offset: expectNullableInteger(
        decodedAnchor.start_offset,
        `${name}.anchor.start_offset`,
      ),
      end_offset: expectNullableInteger(
        decodedAnchor.end_offset,
        `${name}.anchor.end_offset`,
      ),
    },
  };
}

export function decodeHighlightListEnvelope(raw: unknown): Highlight[] {
  const envelope = expectExactRecord(raw, ["data"], "HighlightListResponse");
  const data = expectExactRecord(
    envelope.data,
    ["highlights"],
    "HighlightListResponse.data",
  );
  return expectArray(
    data.highlights,
    (item, index) => decodeHighlight(item, `Highlight[${index}]`),
    "HighlightListResponse.data.highlights",
  );
}

export function decodeHighlightEnvelope(raw: unknown): Highlight {
  const envelope = expectExactRecord(raw, ["data"], "HighlightResponse");
  return decodeHighlight(envelope.data, "HighlightResponse.data");
}

export function decodeHighlightNoteEnvelope(raw: unknown): HighlightLinkedNoteBlock {
  const envelope = expectExactRecord(raw, ["data"], "HighlightNoteResponse");
  return decodeHighlightLinkedNoteBlock(
    envelope.data,
    "HighlightNoteResponse.data",
  );
}
