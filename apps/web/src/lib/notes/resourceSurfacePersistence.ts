import type { Node as ProseMirrorNode } from "prosemirror-model";
import { hasTopLevelLegacyArtifactIdentityKey } from "@/lib/currentArtifactIdentity";
import type { NotePage, SaveResourceSurfaceInput } from "@/lib/notes/api";
import type { NoteBlock } from "@/lib/notes/normalize";
import { outlineSchema } from "@/lib/notes/prosemirror/schema";
import { isRecord } from "@/lib/validation";

export interface PersistedDraftBlock {
  id: string;
  parentBlockId: string | null;
  sourceOrderKey: string;
  bodyPmJson: Record<string, unknown>;
}

export interface PageDraftMetadata {
  knownBlocks: PersistedDraftBlock[];
  focusedRootParentBlockId: string | null;
  titleDraft: string;
}

const PAGE_DRAFT_METADATA_KEYS = new Set([
  "knownBlocks",
  "focusedRootParentBlockId",
  "titleDraft",
]);
const PERSISTED_DRAFT_BLOCK_KEYS = new Set([
  "id",
  "parentBlockId",
  "sourceOrderKey",
  "bodyPmJson",
]);

export function readDraftBlocksForPersistence(
  doc: ProseMirrorNode,
  rootParentBlockId: string | null = null,
): PersistedDraftBlock[] {
  const drafts: PersistedDraftBlock[] = [];

  function readSiblings(parent: ProseMirrorNode, parentBlockId: string | null) {
    const siblings: ProseMirrorNode[] = [];
    parent.forEach((node) => {
      if (node.type === outlineSchema.nodes.outline_block) siblings.push(node);
    });
    siblings.forEach((node, index) => {
      const body = node.child(0);
      drafts.push({
        id: String(node.attrs.id),
        parentBlockId,
        sourceOrderKey: `${index + 1}`.padStart(10, "0"),
        bodyPmJson: nodeJsonRecord(body),
      });
      readSiblings(node, String(node.attrs.id));
    });
  }

  readSiblings(doc, rootParentBlockId);
  return drafts;
}

export function draftBlocksById(
  blocks: PersistedDraftBlock[],
): Map<string, PersistedDraftBlock> {
  return new Map(blocks.map((block) => [block.id, block]));
}

export function flatBlockIds(blocks: NoteBlock[]): string[] {
  return blocks.flatMap((block) => [block.id, ...flatBlockIds(block.children)]);
}

export function flatBlockParentIds(
  blocks: NoteBlock[],
): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  for (const block of blocks) {
    parents.set(block.id, block.parentBlockId);
    for (const [id, parentId] of flatBlockParentIds(block.children)) {
      parents.set(id, parentId);
    }
  }
  return parents;
}

export function resourceSurfaceBlocksFromDrafts(
  drafts: PersistedDraftBlock[],
): SaveResourceSurfaceInput["blocks"] {
  return drafts.map((block) => ({
    id: block.id,
    bodyPmJson: block.bodyPmJson,
  }));
}

export function resourceSurfaceAdjacencyFromDrafts(
  drafts: PersistedDraftBlock[],
  pageId: string,
  extraParentBlockIds: Iterable<string | null> = [],
): SaveResourceSurfaceInput["adjacency"] {
  const parentIds = new Set<string | null>([null]);
  for (const block of drafts) {
    parentIds.add(block.parentBlockId);
  }
  for (const parentId of extraParentBlockIds) {
    parentIds.add(parentId);
  }

  return Array.from(parentIds)
    .sort((first, second) =>
      String(first ?? "").localeCompare(String(second ?? "")),
    )
    .map((parentId) => ({
      parent: parentId
        ? { scheme: "note_block" as const, id: parentId }
        : { scheme: "page" as const, id: pageId },
      children: drafts
        .filter((block) => block.parentBlockId === parentId)
        .sort((first, second) =>
          first.sourceOrderKey === second.sourceOrderKey
            ? first.id.localeCompare(second.id)
            : first.sourceOrderKey.localeCompare(second.sourceOrderKey),
        )
        .map((block) => ({
          blockId: block.id,
          sourceOrderKey: block.sourceOrderKey,
          collapsed: false,
        })),
    }));
}

export function deletedRootBlockIdsForPersistence(
  knownBlockIds: Set<string>,
  nextBlockIds: Set<string>,
  parentBlockIds: Map<string, string | null>,
): string[] {
  const deleted = new Set(
    Array.from(knownBlockIds).filter((id) => !nextBlockIds.has(id)),
  );
  return Array.from(deleted)
    .filter((id) => {
      let parentId = parentBlockIds.get(id) ?? null;
      while (parentId) {
        if (deleted.has(parentId)) return false;
        parentId = parentBlockIds.get(parentId) ?? null;
      }
      return true;
    })
    .sort();
}

export function planResourceSurfaceSave(input: {
  doc: ProseMirrorNode;
  pageId: string;
  rootParentBlockId: string | null;
  knownBlockIds: Set<string>;
  knownBlockParentIds: Map<string, string | null>;
}): {
  blocks: SaveResourceSurfaceInput["blocks"];
  adjacency: SaveResourceSurfaceInput["adjacency"];
  deletedBlockIds: string[];
  nextBlockIds: Set<string>;
  nextBlockParentIds: Map<string, string | null>;
  nextBlockDrafts: Map<string, PersistedDraftBlock>;
} {
  const drafts = readDraftBlocksForPersistence(
    input.doc,
    input.rootParentBlockId,
  );
  const nextBlockIds = new Set(drafts.map((block) => block.id));
  const nextBlockParentIds = new Map(
    drafts.map((block) => [block.id, block.parentBlockId]),
  );
  return {
    blocks: resourceSurfaceBlocksFromDrafts(drafts),
    adjacency: resourceSurfaceAdjacencyFromDrafts(
      drafts,
      input.pageId,
      input.knownBlockParentIds.values(),
    ),
    deletedBlockIds: deletedRootBlockIdsForPersistence(
      input.knownBlockIds,
      nextBlockIds,
      input.knownBlockParentIds,
    ),
    nextBlockIds,
    nextBlockParentIds,
    nextBlockDrafts: draftBlocksById(drafts),
  };
}

export function planNoteBlockDeletion(
  page: NotePage,
  blockId: string,
): {
  blocks: SaveResourceSurfaceInput["blocks"];
  adjacency: SaveResourceSurfaceInput["adjacency"];
  deletedBlockIds: string[];
} | null {
  if (!flatBlockIds(page.blocks).includes(blockId)) return null;
  const deletedIds = blockSubtreeIds(page.blocks, blockId);
  const drafts = noteBlocksToDrafts(page.blocks).filter(
    (block) => !deletedIds.has(block.id),
  );
  return {
    blocks: resourceSurfaceBlocksFromDrafts(drafts),
    adjacency: resourceSurfaceAdjacencyFromDrafts(
      drafts,
      page.id,
      Array.from(flatBlockParentIds(page.blocks).values()).filter(
        (parentId) => !parentId || !deletedIds.has(parentId),
      ),
    ),
    deletedBlockIds: [blockId],
  };
}

export function pageDraftMetadataFromStorage(
  value: unknown,
): PageDraftMetadata | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, PAGE_DRAFT_METADATA_KEYS) ||
    hasTopLevelLegacyArtifactIdentityKey(value)
  ) {
    return null;
  }
  if (
    !Array.isArray(value.knownBlocks) ||
    (value.focusedRootParentBlockId !== null &&
      typeof value.focusedRootParentBlockId !== "string") ||
    typeof value.titleDraft !== "string"
  ) {
    return null;
  }

  const knownBlocks: PersistedDraftBlock[] = [];
  for (const block of value.knownBlocks) {
    if (
      !isRecord(block) ||
      !hasOnlyKeys(block, PERSISTED_DRAFT_BLOCK_KEYS) ||
      hasTopLevelLegacyArtifactIdentityKey(block) ||
      typeof block.id !== "string" ||
      (block.parentBlockId !== null &&
        typeof block.parentBlockId !== "string") ||
      typeof block.sourceOrderKey !== "string" ||
      !isRecord(block.bodyPmJson)
    ) {
      return null;
    }
    knownBlocks.push({
      id: block.id,
      parentBlockId: block.parentBlockId,
      sourceOrderKey: block.sourceOrderKey,
      bodyPmJson: block.bodyPmJson,
    });
  }

  return {
    knownBlocks,
    focusedRootParentBlockId: value.focusedRootParentBlockId,
    titleDraft: value.titleDraft,
  };
}

function nodeJsonRecord(node: ProseMirrorNode): Record<string, unknown> {
  const json = node.toJSON();
  if (!isRecord(json)) {
    throw new Error("ProseMirror node JSON must be an object");
  }
  return json;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function noteBlocksToDrafts(blocks: NoteBlock[]): PersistedDraftBlock[] {
  const drafts: PersistedDraftBlock[] = [];
  for (const block of blocks) {
    drafts.push({
      id: block.id,
      parentBlockId: block.parentBlockId,
      sourceOrderKey: block.orderKey ?? "0000000001",
      bodyPmJson: block.bodyPmJson,
    });
    drafts.push(...noteBlocksToDrafts(block.children));
  }
  return drafts;
}

function blockSubtreeIds(blocks: NoteBlock[], blockId: string): Set<string> {
  for (const block of blocks) {
    if (block.id === blockId) return new Set(flatBlockIds([block]));
    const childIds = blockSubtreeIds(block.children, blockId);
    if (childIds.size > 0) return childIds;
  }
  return new Set();
}
