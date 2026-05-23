"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import NoteBacklinks from "@/components/notes/NoteBacklinks";
import ProseMirrorOutlineEditor from "@/components/notes/ProseMirrorOutlineEditor";
import Button from "@/components/ui/Button";
import { usePaneParam, usePaneRuntime, useSetPaneTitle } from "@/lib/panes/paneRuntime";
import { isObjectType, resolveObjectRefs } from "@/lib/objectRefs";
import {
  createEmptyOutlineDoc,
  noteBlocksToOutlineDoc,
  outlineSchema,
} from "@/lib/notes/prosemirror/schema";
import {
  fetchNoteBlock,
  fetchNotePage,
  updateNotePage,
  saveNotePageDocument,
  type NoteBlock,
  type NoteBlockKind,
  type NotePage,
} from "@/lib/notes/api";
import {
  clearStoredNoteEditorDraft,
  readStoredNoteEditorDraft,
  useNoteEditorSession,
  type NoteEditorSessionStatus,
} from "@/lib/notes/useNoteEditorSession";
import styles from "../../notes/notes.module.css";

interface PersistedDraftBlock {
  id: string;
  parentBlockId: string | null;
  beforeBlockId: string | null;
  afterBlockId: string | null;
  blockKind: NoteBlockKind;
  bodyPmJson: Record<string, unknown>;
  collapsed: boolean;
}

interface PageDraftMetadata {
  pageRevision: number;
  blockRevisions: [string, number][];
  knownBlocks: PersistedDraftBlock[];
  focusedRootParentBlockId: string | null;
}

export default function PagePaneBody({
  pageIdOverride,
  focusBlockId,
  initialPage,
}: {
  pageIdOverride?: string;
  focusBlockId?: string;
  initialPage?: NotePage;
}) {
  const routePageId = usePaneParam("pageId");
  const paneRuntime = usePaneRuntime();
  const pageId = pageIdOverride ?? routePageId;
  if (!pageId) throw new Error("page route requires a page id");

  const [page, setPage] = useState<NotePage | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [initialDoc, setInitialDoc] = useState<ProseMirrorNode | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [editorResetVersion, setEditorResetVersion] = useState(0);
  const [conflictAction, setConflictAction] = useState<"discard" | "overwrite" | null>(null);
  const saveScope = focusBlockId ? `block:${focusBlockId}` : `page:${pageId}`;
  const editorResourceKey = `${saveScope}:editor:${editorResetVersion}`;
  const pageRevisionRef = useRef<number | null>(null);
  const knownBlockIdsRef = useRef<Set<string>>(new Set());
  const knownBlockParentIdsRef = useRef<Map<string, string | null>>(new Map());
  const knownBlockRevisionsRef = useRef<Map<string, number>>(new Map());
  const knownBlockDraftsRef = useRef<Map<string, PersistedDraftBlock>>(new Map());
  const focusedRootParentBlockIdRef = useRef<string | null>(null);
  const currentSaveScopeRef = useRef(saveScope);

  const fallbackTitle = focusBlockId ? "Note" : "Page";
  useSetPaneTitle(page ? page.title || fallbackTitle : feedback ? fallbackTitle : null);

  useEffect(() => {
    currentSaveScopeRef.current = saveScope;
  }, [saveScope]);

  const saveDoc = useCallback(
    async (doc: ProseMirrorNode, { clientMutationId }: { clientMutationId: string }) => {
      const scope = saveScope;
      const knownBlockIds = new Set(knownBlockIdsRef.current);
      const knownBlockRevisions = new Map(knownBlockRevisionsRef.current);
      const knownBlockDrafts = new Map(knownBlockDraftsRef.current);
      const drafts = readDraftBlocksForPersistence(
        doc,
        focusBlockId ? focusedRootParentBlockIdRef.current : null
      );
      const basePageRevision = pageRevisionRef.current;
      if (basePageRevision === null) {
        throw new Error("Loaded note page is missing a revision");
      }
      const nextIds = new Set(drafts.map((block) => block.id));
      const deletedBlocks = deletedRootBlockIdsForPersistence(
        knownBlockIds,
        nextIds,
        knownBlockParentIdsRef.current
      ).map((blockId) => {
        const baseRevision = knownBlockRevisions.get(blockId);
        if (baseRevision === undefined) {
          throw new Error("Known note block is missing a revision");
        }
        return { id: blockId, baseRevision };
      });
      const changedBlocks = drafts.filter((block) => {
        if (!knownBlockIds.has(block.id)) {
          return true;
        }
        const knownBlock = knownBlockDrafts.get(block.id);
        if (!knownBlock) {
          throw new Error("Known note block is missing draft metadata");
        }
        return draftBlockChanged(block, knownBlock);
      });

      const result = await saveNotePageDocument(pageId, {
        clientMutationId,
        basePageRevision,
        focusBlockId: focusBlockId ?? null,
        topLevelParentBlockId: focusBlockId ? focusedRootParentBlockIdRef.current : null,
        blocks: changedBlocks.map((block) => {
          if (!knownBlockIds.has(block.id)) {
            return { ...block, baseRevision: null };
          }
          const baseRevision = knownBlockRevisions.get(block.id);
          if (baseRevision === undefined) {
            throw new Error("Known note block is missing a revision");
          }
          return { ...block, baseRevision };
        }),
        deletedBlocks,
      });

      if (currentSaveScopeRef.current === scope) {
        const responseRevisions = flatBlockRevisions(result.page.blocks);
        knownBlockIdsRef.current = nextIds;
        knownBlockParentIdsRef.current = new Map(
          drafts.map((block) => [block.id, block.parentBlockId])
        );
        knownBlockDraftsRef.current = draftBlocksById(drafts);
        knownBlockRevisionsRef.current =
          responseRevisions.size > 0 ? responseRevisions : new Map();
        pageRevisionRef.current = requiredRevision(result.page.revision);
        setPage((currentPage) =>
          currentPage
            ? {
                ...currentPage,
                revision: result.page.revision,
                updatedAt: result.page.updatedAt,
              }
            : result.page
        );
      }
    },
    [focusBlockId, pageId, saveScope]
  );

  const draftMetadata = useCallback((): PageDraftMetadata | null => {
    const pageRevision = pageRevisionRef.current;
    if (pageRevision === null) {
      return null;
    }
    return {
      pageRevision,
      blockRevisions: Array.from(knownBlockRevisionsRef.current.entries()),
      knownBlocks: Array.from(knownBlockDraftsRef.current.values()),
      focusedRootParentBlockId: focusedRootParentBlockIdRef.current,
    };
  }, []);

  const session = useNoteEditorSession({
    resourceKey: saveScope,
    save: saveDoc,
    draftMetadata,
    onError: (error) => {
      setFeedback(toFeedback(error, { fallback: "Notes could not be saved." }));
    },
    onConflict: (error) => {
      setFeedback(toFeedback(error, { fallback: "Notes have a save conflict." }));
    },
  });
  const {
    status: saveStatus,
    scheduleSave: scheduleSessionSave,
    flush: flushSession,
    reset: resetSession,
  } = session;

  const loadServerDocument = useCallback(async (): Promise<ProseMirrorNode> => {
    const loadedPage = await fetchNotePage(pageId);
    if (!focusBlockId) {
      setPage(loadedPage);
      setTitleDraft(loadedPage.title);
      pageRevisionRef.current = requiredRevision(loadedPage.revision);
      focusedRootParentBlockIdRef.current = null;
      knownBlockIdsRef.current = new Set(flatPageBlockIds(loadedPage));
      knownBlockParentIdsRef.current = flatBlockParentIds(loadedPage.blocks);
      knownBlockRevisionsRef.current = flatBlockRevisions(loadedPage.blocks);
      const persistedDoc = loadedPage.blocks.length
        ? noteBlocksToOutlineDoc(loadedPage.blocks)
        : null;
      knownBlockDraftsRef.current = persistedDoc
        ? draftBlocksById(readDraftBlocksForPersistence(persistedDoc))
        : new Map();
      return persistedDoc ?? createEmptyOutlineDoc(newBlockId());
    }

    const block = await fetchNoteBlock(focusBlockId);
    setPage({ ...loadedPage, blocks: [block] });
    setTitleDraft(loadedPage.title);
    pageRevisionRef.current = requiredRevision(loadedPage.revision);
    focusedRootParentBlockIdRef.current = block.parentBlockId;
    knownBlockIdsRef.current = new Set(flatBlockIds([block]));
    knownBlockParentIdsRef.current = flatBlockParentIds([block]);
    knownBlockRevisionsRef.current = flatBlockRevisions([block]);
    const doc = noteBlocksToOutlineDoc([block]);
    knownBlockDraftsRef.current = draftBlocksById(readDraftBlocksForPersistence(doc));
    return doc;
  }, [focusBlockId, pageId]);

  useEffect(() => {
    let cancelled = false;
    setFeedback(null);
    setPage(null);
    setTitleDraft("");
    setInitialDoc(null);
    resetSession();
    const loadPage =
      initialPage && initialPage.id === pageId ? Promise.resolve(initialPage) : fetchNotePage(pageId);
    loadPage
      .then(async (loadedPage) => {
        if (cancelled) return;
        if (!focusBlockId) {
          setPage(loadedPage);
          setTitleDraft(loadedPage.title);
          pageRevisionRef.current = requiredRevision(loadedPage.revision);
          focusedRootParentBlockIdRef.current = null;
          knownBlockIdsRef.current = new Set(flatPageBlockIds(loadedPage));
          knownBlockParentIdsRef.current = flatBlockParentIds(loadedPage.blocks);
          knownBlockRevisionsRef.current = flatBlockRevisions(loadedPage.blocks);
          const persistedDoc = loadedPage.blocks.length
            ? noteBlocksToOutlineDoc(loadedPage.blocks)
            : null;
          knownBlockDraftsRef.current = persistedDoc
            ? draftBlocksById(readDraftBlocksForPersistence(persistedDoc))
            : new Map();
          const storedDraft = readStoredNoteEditorDraft(saveScope);
          const storedMetadata = storedDraft
            ? pageDraftMetadataFromStorage(storedDraft.metadata)
            : null;
          if (storedDraft && storedMetadata) {
            pageRevisionRef.current = storedMetadata.pageRevision;
            knownBlockIdsRef.current = new Set(
              storedMetadata.knownBlocks.map((block) => block.id)
            );
            knownBlockParentIdsRef.current = new Map(
              storedMetadata.knownBlocks.map((block) => [block.id, block.parentBlockId])
            );
            knownBlockRevisionsRef.current = new Map(storedMetadata.blockRevisions);
            knownBlockDraftsRef.current = draftBlocksById(storedMetadata.knownBlocks);
            focusedRootParentBlockIdRef.current = storedMetadata.focusedRootParentBlockId;
            setInitialDoc(storedDraft.doc);
            scheduleSessionSave(storedDraft.doc);
            return;
          }
          if (storedDraft) {
            clearStoredNoteEditorDraft(saveScope);
          }
          setInitialDoc(persistedDoc ?? createEmptyOutlineDoc(newBlockId()));
          return;
        }
        const block = await fetchNoteBlock(focusBlockId);
        if (cancelled) return;
        setPage({ ...loadedPage, blocks: [block] });
        setTitleDraft(loadedPage.title);
        pageRevisionRef.current = requiredRevision(loadedPage.revision);
        focusedRootParentBlockIdRef.current = block.parentBlockId;
        knownBlockIdsRef.current = new Set(flatBlockIds([block]));
        knownBlockParentIdsRef.current = flatBlockParentIds([block]);
        knownBlockRevisionsRef.current = flatBlockRevisions([block]);
        const doc = noteBlocksToOutlineDoc([block]);
        knownBlockDraftsRef.current = draftBlocksById(readDraftBlocksForPersistence(doc));
        const storedDraft = readStoredNoteEditorDraft(saveScope);
        const storedMetadata = storedDraft
          ? pageDraftMetadataFromStorage(storedDraft.metadata)
          : null;
        if (storedDraft && storedMetadata) {
          pageRevisionRef.current = storedMetadata.pageRevision;
          knownBlockIdsRef.current = new Set(storedMetadata.knownBlocks.map((item) => item.id));
          knownBlockParentIdsRef.current = new Map(
            storedMetadata.knownBlocks.map((item) => [item.id, item.parentBlockId])
          );
          knownBlockRevisionsRef.current = new Map(storedMetadata.blockRevisions);
          knownBlockDraftsRef.current = draftBlocksById(storedMetadata.knownBlocks);
          focusedRootParentBlockIdRef.current = storedMetadata.focusedRootParentBlockId;
          setInitialDoc(storedDraft.doc);
          scheduleSessionSave(storedDraft.doc);
          return;
        }
        if (storedDraft) {
          clearStoredNoteEditorDraft(saveScope);
        }
        setInitialDoc(doc);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFeedback(toFeedback(error, { fallback: "Note could not be loaded." }));
      });
    return () => {
      cancelled = true;
      flushSession();
    };
  }, [
    flushSession,
    focusBlockId,
    initialPage,
    pageId,
    resetSession,
    saveScope,
    scheduleSessionSave,
  ]);

  const saveTitle = useCallback(
    async (title: string) => {
      const trimmed = title.trim();
      if (!page || !trimmed || trimmed === page.title) return;
      try {
        const updated = await updateNotePage(page.id, { title: trimmed });
        pageRevisionRef.current = requiredRevision(updated.revision);
        setPage(updated);
        setTitleDraft(updated.title);
      } catch (error: unknown) {
        setFeedback(toFeedback(error, { fallback: "Title could not be saved." }));
      }
    },
    [page]
  );

  const discardLocalDraft = useCallback(async () => {
    setConflictAction("discard");
    setFeedback(null);
    try {
      clearStoredNoteEditorDraft(saveScope);
      resetSession();
      const doc = await loadServerDocument();
      setInitialDoc(doc);
      setEditorResetVersion((version) => version + 1);
    } catch (error: unknown) {
      setFeedback(toFeedback(error, { fallback: "Latest note could not be loaded." }));
    } finally {
      setConflictAction(null);
    }
  }, [loadServerDocument, resetSession, saveScope]);

  const overwriteWithLocalDraft = useCallback(async () => {
    setConflictAction("overwrite");
    setFeedback(null);
    try {
      await loadServerDocument();
      flushSession();
    } catch (error: unknown) {
      setFeedback(toFeedback(error, { fallback: "Latest note revisions could not be loaded." }));
    } finally {
      setConflictAction(null);
    }
  }, [flushSession, loadServerDocument]);

  const openBlock = useCallback(
    (blockId: string, openInNewPane: boolean) => {
      if (!blockId) return;
      const href = `/notes/${blockId}`;
      if (openInNewPane) paneRuntime?.openInNewPane(href);
      else paneRuntime?.router.push(href);
    },
    [paneRuntime]
  );

  const openObject = useCallback(
    async (objectType: string, objectId: string, openInNewPane: boolean) => {
      if (!isObjectType(objectType)) return;
      let href: string | null = null;
      try {
        const [resolved] = await resolveObjectRefs([{ objectType, objectId }]);
        href = resolved?.route ?? null;
      } catch (error: unknown) {
        setFeedback(toFeedback(error, { fallback: "Linked object could not be opened." }));
        return;
      }
      if (!href) return;
      if (openInNewPane) paneRuntime?.openInNewPane(href);
      else paneRuntime?.router.push(href);
    },
    [paneRuntime]
  );

  if (feedback && !initialDoc) return <FeedbackNotice {...feedback} />;
  if (!page || !initialDoc) return <FeedbackNotice severity="info" title="Loading note..." />;

  return (
    <div className={styles.editorShell}>
      <input
        className={styles.titleInput}
        value={titleDraft}
        onChange={(event) => setTitleDraft(event.currentTarget.value)}
        onBlur={(event) => void saveTitle(event.currentTarget.value)}
        aria-label="Page title"
      />
      <div className={styles.editorMeta}>{saveLabelForStatus(saveStatus)}</div>
      {saveStatus === "conflict" ? (
        <FeedbackNotice
          severity="warning"
          title="Notes have a save conflict."
          message="Your local draft is still here."
        >
          <div className={styles.conflictActions}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void overwriteWithLocalDraft()}
              disabled={conflictAction !== null}
            >
              Keep local draft
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void discardLocalDraft()}
              disabled={conflictAction !== null}
            >
              Reload latest
            </Button>
          </div>
        </FeedbackNotice>
      ) : feedback ? (
        <FeedbackNotice {...feedback} />
      ) : null}
      <ProseMirrorOutlineEditor
        resourceKey={editorResourceKey}
        initialDoc={initialDoc}
        createBlockId={newBlockId}
        onDocChange={scheduleSessionSave}
        onBlurFlush={flushSession}
        onOpenBlock={openBlock}
        onOpenObject={openObject}
      />
      <div className={styles.backlinks}>
        <NoteBacklinks
          objectRef={{
            objectType: focusBlockId ? "note_block" : "page",
            objectId: focusBlockId ?? page.id,
          }}
        />
      </div>
    </div>
  );
}

function newBlockId(): string {
  return crypto.randomUUID();
}

function saveLabelForStatus(status: NoteEditorSessionStatus): string {
  if (status === "dirty") return "Unsaved";
  if (status === "saving") return "Saving...";
  if (status === "failed") return "Save failed";
  if (status === "conflict") return "Conflict";
  return "Saved";
}

export function readDraftBlocksForPersistence(
  doc: ProseMirrorNode,
  topLevelParentBlockId: string | null = null
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
        beforeBlockId:
          index === 0 && siblings[index + 1] ? String(siblings[index + 1]!.attrs.id) : null,
        afterBlockId: index > 0 ? String(siblings[index - 1]!.attrs.id) : null,
        blockKind: (node.attrs.kind ?? "bullet") as NoteBlockKind,
        bodyPmJson: paragraph.toJSON() as Record<string, unknown>,
        collapsed: Boolean(node.attrs.collapsed),
      });
      readSiblings(node, String(node.attrs.id));
    });
  }

  readSiblings(doc, topLevelParentBlockId);
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

function draftBlocksById(blocks: PersistedDraftBlock[]): Map<string, PersistedDraftBlock> {
  return new Map(blocks.map((block) => [block.id, block]));
}

function draftBlockChanged(current: PersistedDraftBlock, previous: PersistedDraftBlock): boolean {
  return (
    current.parentBlockId !== previous.parentBlockId ||
    current.beforeBlockId !== previous.beforeBlockId ||
    current.afterBlockId !== previous.afterBlockId ||
    current.blockKind !== previous.blockKind ||
    current.collapsed !== previous.collapsed ||
    JSON.stringify(current.bodyPmJson) !== JSON.stringify(previous.bodyPmJson)
  );
}

function pageDraftMetadataFromStorage(value: unknown): PageDraftMetadata | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const metadata = value as Partial<PageDraftMetadata>;
  if (
    typeof metadata.pageRevision !== "number" ||
    !Number.isFinite(metadata.pageRevision) ||
    !Array.isArray(metadata.blockRevisions) ||
    !Array.isArray(metadata.knownBlocks) ||
    (metadata.focusedRootParentBlockId !== null &&
      typeof metadata.focusedRootParentBlockId !== "string")
  ) {
    return null;
  }

  const blockRevisions: [string, number][] = [];
  for (const entry of metadata.blockRevisions) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "number" ||
      !Number.isFinite(entry[1])
    ) {
      return null;
    }
    blockRevisions.push([entry[0], entry[1]]);
  }

  const knownBlocks: PersistedDraftBlock[] = [];
  for (const block of metadata.knownBlocks) {
    if (
      typeof block !== "object" ||
      block === null ||
      typeof block.id !== "string" ||
      (block.parentBlockId !== null && typeof block.parentBlockId !== "string") ||
      (block.beforeBlockId !== null && typeof block.beforeBlockId !== "string") ||
      (block.afterBlockId !== null && typeof block.afterBlockId !== "string") ||
      typeof block.blockKind !== "string" ||
      typeof block.bodyPmJson !== "object" ||
      block.bodyPmJson === null ||
      typeof block.collapsed !== "boolean"
    ) {
      return null;
    }
    knownBlocks.push(block);
  }

  return {
    pageRevision: metadata.pageRevision,
    blockRevisions,
    knownBlocks,
    focusedRootParentBlockId: metadata.focusedRootParentBlockId,
  };
}

function flatPageBlockIds(page: NotePage): string[] {
  return flatBlockIds(page.blocks);
}

interface BlockWithChildren {
  id: string;
  revision?: number;
  children: BlockWithChildren[];
}

function flatBlockIds(blocks: BlockWithChildren[]): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    ids.push(block.id);
    ids.push(...flatBlockIds(block.children));
  }
  return ids;
}

function flatBlockParentIds(blocks: BlockWithChildren[]): Map<string, string | null> {
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

function flatBlockRevisions(blocks: NoteBlock[]): Map<string, number> {
  const revisions = new Map<string, number>();

  function visit(children: NoteBlock[]) {
    for (const block of children) {
      revisions.set(block.id, requiredRevision(block.revision));
      visit(block.children);
    }
  }

  visit(blocks);
  return revisions;
}

function requiredRevision(revision: number | undefined): number {
  if (typeof revision !== "number" || !Number.isFinite(revision)) {
    throw new Error("Loaded note page is missing revision metadata");
  }
  return revision;
}
