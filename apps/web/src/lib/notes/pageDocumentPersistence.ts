import type { Node as ProseMirrorNode } from "prosemirror-model";
import { hasTopLevelLegacyArtifactIdentityKey } from "@/lib/currentArtifactIdentity";
import {
  isNoteBlockKind,
  type NoteBlock,
  type NotePage,
  type NoteBlockKind,
  type SaveNotePageDocumentBlock,
  type SaveNotePageDocumentContainment,
} from "@/lib/notes/api";
import {
  noteBlocksToOutlineDoc,
  outlineSchema,
} from "@/lib/notes/prosemirror/schema";
import { isRecord } from "@/lib/validation";

export interface PersistedDraftBlock {
  id: string;
  parentBlockId: string | null;
  sourceOrderKey: string;
  blockKind: NoteBlockKind;
  bodyPmJson: Record<string, unknown>;
  collapsed: boolean;
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
  "blockKind",
  "bodyPmJson",
  "collapsed",
]);

export function planPageDocumentSave(input: {
  doc: ProseMirrorNode;
  pageId: string;
  rootParentBlockId: string | null;
  knownBlockIds: Set<string>;
  knownBlockParentIds: Map<string, string | null>;
}) {
  const drafts = readDraftBlocksForPersistence(input.doc, input.rootParentBlockId);
  const nextBlockIds = new Set(drafts.map((block) => block.id));
  const deletedBlockIds = deletedRootBlockIdsForPersistence(
    input.knownBlockIds,
    nextBlockIds,
    input.knownBlockParentIds
  );
  return {
    blocks: pageDocumentBlocksFromDrafts(drafts),
    containment: pageDocumentContainmentFromDrafts(drafts, input.pageId),
    deletedBlockIds,
    nextBlockIds,
    nextBlockParentIds: new Map(drafts.map((block) => [block.id, block.parentBlockId])),
    nextBlockDrafts: draftBlocksById(drafts),
  };
}

export function planNoteBlockDeletion(page: NotePage, blockId: string) {
  const knownBlockIds = new Set(flatBlockIds(page.blocks));
  if (!knownBlockIds.has(blockId)) {
    return null;
  }
  const knownBlockParentIds = flatBlockParentIds(page.blocks);
  const nextBlocks = removeBlockSubtree(page.blocks, blockId);
  const nextBlockIds = new Set(flatBlockIds(nextBlocks));
  const drafts = readDraftBlocksForPersistence(noteBlocksToOutlineDoc(nextBlocks));
  return {
    blocks: pageDocumentBlocksFromDrafts(drafts),
    containment: pageDocumentContainmentFromDrafts(drafts, page.id),
    deletedBlockIds: deletedRootBlockIdsForPersistence(
      knownBlockIds,
      nextBlockIds,
      knownBlockParentIds
    ),
  };
}

export function readDraftBlocksForPersistence(
  doc: ProseMirrorNode,
  rootParentBlockId: string | null = null
): PersistedDraftBlock[] {
  const drafts: PersistedDraftBlock[] = [];

  function readSiblings(parent: ProseMirrorNode, parentBlockId: string | null) {
    const siblings: ProseMirrorNode[] = [];
    parent.forEach((node) => {
      if (node.type === outlineSchema.nodes.outline_block) siblings.push(node);
    });
    siblings.forEach((node, index) => {
      const paragraph = node.child(0);
      drafts.push({
        id: String(node.attrs.id),
        parentBlockId,
        sourceOrderKey: `${index + 1}`.padStart(10, "0"),
        blockKind: draftBlockKind(node.attrs.kind),
        bodyPmJson: nodeJsonRecord(paragraph),
        collapsed: Boolean(node.attrs.collapsed),
      });
      readSiblings(node, String(node.attrs.id));
    });
  }

  readSiblings(doc, rootParentBlockId);
  return drafts;
}

export function deletedRootBlockIdsForPersistence(
  knownBlockIds: Set<string>,
  nextIds: Set<string>,
  knownParentBlockIds: Map<string, string | null>
): string[] {
  const rootIds: string[] = [];
  for (const blockId of knownBlockIds) {
    if (nextIds.has(blockId)) continue;

    let parentBlockId = knownParentBlockIds.get(blockId) ?? null;
    let hasDeletedAncestor = false;
    while (parentBlockId) {
      if (knownBlockIds.has(parentBlockId) && !nextIds.has(parentBlockId)) {
        hasDeletedAncestor = true;
        break;
      }
      parentBlockId = knownParentBlockIds.get(parentBlockId) ?? null;
    }

    if (!hasDeletedAncestor) rootIds.push(blockId);
  }
  return rootIds;
}

export function draftBlocksById(
  blocks: PersistedDraftBlock[]
): Map<string, PersistedDraftBlock> {
  return new Map(blocks.map((block) => [block.id, block]));
}

export function pageDocumentBlocksFromDrafts(
  drafts: PersistedDraftBlock[]
): SaveNotePageDocumentBlock[] {
  return drafts.map((block) => ({
    id: block.id,
    blockKind: block.blockKind,
    bodyPmJson: block.bodyPmJson,
  }));
}

export function pageDocumentContainmentFromDrafts(
  drafts: PersistedDraftBlock[],
  pageId: string
): SaveNotePageDocumentContainment[] {
  const groups = new Map<string, PersistedDraftBlock[]>();
  for (const block of drafts) {
    const parentKey = block.parentBlockId ?? "";
    groups.set(parentKey, [...(groups.get(parentKey) ?? []), block]);
  }

  return Array.from(groups.entries()).map(([parentBlockId, children]) => ({
    parent: parentBlockId
      ? { scheme: "note_block", id: parentBlockId }
      : { scheme: "page", id: pageId },
    children: children
      .sort((first, second) =>
        first.sourceOrderKey === second.sourceOrderKey
          ? first.id.localeCompare(second.id)
          : first.sourceOrderKey.localeCompare(second.sourceOrderKey)
      )
      .map((child) => ({
        blockId: child.id,
        sourceOrderKey: child.sourceOrderKey,
        collapsed: child.collapsed,
      })),
  }));
}

export function pageDraftMetadataFromStorage(value: unknown): PageDraftMetadata | null {
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
      (block.parentBlockId !== null && typeof block.parentBlockId !== "string") ||
      typeof block.sourceOrderKey !== "string" ||
      !isNoteBlockKind(block.blockKind) ||
      !isRecord(block.bodyPmJson) ||
      typeof block.collapsed !== "boolean"
    ) {
      return null;
    }
    knownBlocks.push({
      id: block.id,
      parentBlockId: block.parentBlockId,
      sourceOrderKey: block.sourceOrderKey,
      blockKind: block.blockKind,
      bodyPmJson: block.bodyPmJson,
      collapsed: block.collapsed,
    });
  }

  return {
    knownBlocks,
    focusedRootParentBlockId: value.focusedRootParentBlockId,
    titleDraft: value.titleDraft,
  };
}

export function flatBlockIds(blocks: BlockWithChildren[]): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    ids.push(block.id);
    ids.push(...flatBlockIds(block.children));
  }
  return ids;
}

export function flatBlockParentIds(blocks: BlockWithChildren[]): Map<string, string | null> {
  const parentIds = new Map<string, string | null>();

  function visit(children: BlockWithChildren[], parentBlockId: string | null) {
    for (const block of children) {
      parentIds.set(block.id, parentBlockId);
      visit(block.children, block.id);
    }
  }

  visit(blocks, null);
  return parentIds;
}

function removeBlockSubtree(blocks: NoteBlock[], blockId: string): NoteBlock[] {
  return blocks
    .filter((block) => block.id !== blockId)
    .map((block) => ({
      ...block,
      children: removeBlockSubtree(block.children, blockId),
    }));
}

function draftBlockKind(value: unknown): NoteBlockKind {
  return isNoteBlockKind(value) ? value : "bullet";
}

function nodeJsonRecord(node: ProseMirrorNode): Record<string, unknown> {
  const json = node.toJSON();
  if (!isRecord(json)) {
    throw new Error("ProseMirror node JSON must be an object");
  }
  return json;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

interface BlockWithChildren {
  id: string;
  children: BlockWithChildren[];
}
