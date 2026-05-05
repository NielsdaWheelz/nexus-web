"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import NoteBacklinks from "@/components/notes/NoteBacklinks";
import ProseMirrorOutlineEditor from "@/components/notes/ProseMirrorOutlineEditor";
import { usePaneParam, usePaneRuntime, useSetPaneTitle } from "@/lib/panes/paneRuntime";
import { hrefForObject } from "@/lib/objectLinks";
import { isObjectType, resolveObjectRefs } from "@/lib/objectRefs";
import {
  createEmptyOutlineDoc,
  noteBlocksToOutlineDoc,
  outlineSchema,
} from "@/lib/notes/prosemirror/schema";
import {
  createNoteBlock,
  deleteNoteBlock,
  fetchNoteBlock,
  fetchNotePage,
  moveNoteBlock,
  updateNoteBlock,
  updateNotePage,
  type NoteBlockKind,
  type NotePage,
} from "@/lib/notes/api";
import styles from "../../notes/notes.module.css";

export interface PersistedDraftBlock {
  id: string;
  parentBlockId: string | null;
  beforeBlockId: string | null;
  afterBlockId: string | null;
  blockKind: NoteBlockKind;
  bodyPmJson: Record<string, unknown>;
  collapsed: boolean;
}

export default function PagePaneBody({
  pageIdOverride,
  focusBlockId,
}: {
  pageIdOverride?: string;
  focusBlockId?: string;
}) {
  const routePageId = usePaneParam("pageId");
  const paneRuntime = usePaneRuntime();
  const pageId = pageIdOverride ?? routePageId;
  if (!pageId) throw new Error("page route requires a page id");

  const [page, setPage] = useState<NotePage | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [initialDoc, setInitialDoc] = useState<ProseMirrorNode | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [saveLabel, setSaveLabel] = useState("Saved");
  const saveScope = `${pageId}:${focusBlockId ?? ""}`;
  const knownBlockIdsRef = useRef<Set<string>>(new Set());
  const knownBlockParentIdsRef = useRef<Map<string, string | null>>(new Map());
  const focusedRootParentBlockIdRef = useRef<string | null>(null);
  const pendingDocRef = useRef<ProseMirrorNode | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const savingScopesRef = useRef<Set<string>>(new Set());
  const queuedDocsRef = useRef<Map<string, ProseMirrorNode>>(new Map());
  const mountedRef = useRef(true);
  const currentSaveScopeRef = useRef(saveScope);

  useSetPaneTitle(page?.title ?? (focusBlockId ? "Note" : "Page"));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    currentSaveScopeRef.current = saveScope;
  }, [saveScope]);

  const saveDoc = useCallback(
    async (doc: ProseMirrorNode) => {
      const scope = saveScope;
      if (savingScopesRef.current.has(scope)) {
        queuedDocsRef.current.set(scope, doc);
        return;
      }
      savingScopesRef.current.add(scope);
      if (mountedRef.current && currentSaveScopeRef.current === scope) {
        setSaveLabel("Saving...");
      }
      try {
        const knownBlockIds = new Set(knownBlockIdsRef.current);
        const drafts = readDraftBlocksForPersistence(
          doc,
          focusBlockId ? focusedRootParentBlockIdRef.current : null
        );
        const nextIds = new Set(drafts.map((block) => block.id));
        for (const block of drafts) {
          if (knownBlockIds.has(block.id)) {
            await updateNoteBlock(block.id, {
              bodyPmJson: block.bodyPmJson,
              blockKind: block.blockKind,
              collapsed: block.collapsed,
            });
          } else {
            await createNoteBlock({
              id: block.id,
              pageId,
              parentBlockId: block.parentBlockId,
              blockKind: block.blockKind,
              bodyPmJson: block.bodyPmJson,
            });
          }
        }
        for (const block of drafts) {
          if (focusBlockId && block.id === focusBlockId) continue;
          if (block.afterBlockId) {
            await moveNoteBlock(block.id, {
              parentBlockId: block.parentBlockId,
              afterBlockId: block.afterBlockId,
            });
          } else {
            await moveNoteBlock(block.id, {
              parentBlockId: block.parentBlockId,
              beforeBlockId: block.beforeBlockId,
            });
          }
        }
        for (const blockId of deletedRootBlockIdsForPersistence(
          knownBlockIds,
          nextIds,
          knownBlockParentIdsRef.current
        )) {
          await deleteNoteBlock(blockId);
        }
        if (currentSaveScopeRef.current === scope) {
          knownBlockIdsRef.current = nextIds;
          knownBlockParentIdsRef.current = new Map(
            drafts.map((block) => [block.id, block.parentBlockId])
          );
        }
        if (mountedRef.current && currentSaveScopeRef.current === scope) {
          setSaveLabel("Saved");
        }
      } catch (error: unknown) {
        if (mountedRef.current && currentSaveScopeRef.current === scope) {
          setFeedback(toFeedback(error, { fallback: "Notes could not be saved." }));
          setSaveLabel("Save failed");
        }
      } finally {
        savingScopesRef.current.delete(scope);
        const queuedDoc = queuedDocsRef.current.get(scope);
        if (queuedDoc) {
          queuedDocsRef.current.delete(scope);
          void saveDoc(queuedDoc);
        }
      }
    },
    [focusBlockId, pageId, saveScope]
  );

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pendingDoc = pendingDocRef.current;
    if (!pendingDoc) return;
    pendingDocRef.current = null;
    void saveDoc(pendingDoc);
  }, [saveDoc]);

  useEffect(() => {
    let cancelled = false;
    setFeedback(null);
    setPage(null);
    setTitleDraft("");
    setInitialDoc(null);
    setSaveLabel("Saved");
    pendingDocRef.current = null;
    fetchNotePage(pageId)
      .then(async (loadedPage) => {
        if (cancelled) return;
        if (!focusBlockId) {
          setPage(loadedPage);
          setTitleDraft(loadedPage.title);
          focusedRootParentBlockIdRef.current = null;
          knownBlockIdsRef.current = new Set(flatPageBlockIds(loadedPage));
          knownBlockParentIdsRef.current = flatBlockParentIds(loadedPage.blocks);
          const doc = loadedPage.blocks.length
            ? noteBlocksToOutlineDoc(loadedPage.blocks)
            : createEmptyOutlineDoc(newBlockId());
          setInitialDoc(doc);
          return;
        }
        const block = await fetchNoteBlock(focusBlockId);
        if (cancelled) return;
        setPage({ ...loadedPage, blocks: [block] });
        setTitleDraft(loadedPage.title);
        focusedRootParentBlockIdRef.current = block.parentBlockId;
        knownBlockIdsRef.current = new Set(flatBlockIds([block]));
        knownBlockParentIdsRef.current = flatBlockParentIds([block]);
        const doc = noteBlocksToOutlineDoc([block]);
        setInitialDoc(doc);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFeedback(toFeedback(error, { fallback: "Note could not be loaded." }));
      });
    return () => {
      cancelled = true;
      flushPendingSave();
    };
  }, [flushPendingSave, focusBlockId, pageId]);

  const scheduleSave = useCallback(
    (doc: ProseMirrorNode) => {
      pendingDocRef.current = doc;
      setSaveLabel("Unsaved");
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        const pendingDoc = pendingDocRef.current;
        pendingDocRef.current = null;
        if (pendingDoc) void saveDoc(pendingDoc);
      }, 500);
    },
    [saveDoc]
  );

  const saveTitle = useCallback(
    async (title: string) => {
      const trimmed = title.trim();
      if (!page || !trimmed || trimmed === page.title) return;
      try {
        const updated = await updateNotePage(page.id, { title: trimmed });
        setPage(updated);
        setTitleDraft(updated.title);
      } catch (error: unknown) {
        setFeedback(toFeedback(error, { fallback: "Title could not be saved." }));
      }
    },
    [page]
  );

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
      let href = hrefForObject({ objectType, objectId });
      if (!href) {
        try {
          const [resolved] = await resolveObjectRefs([{ objectType, objectId }]);
          href = resolved ? hrefForObject(resolved) : null;
        } catch (error: unknown) {
          setFeedback(toFeedback(error, { fallback: "Linked object could not be opened." }));
          return;
        }
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
      <div className={styles.editorMeta}>{saveLabel}</div>
      {feedback ? <FeedbackNotice {...feedback} /> : null}
      <ProseMirrorOutlineEditor
        doc={initialDoc}
        createBlockId={newBlockId}
        onDocChange={scheduleSave}
        onOpenBlock={openBlock}
        onOpenObject={openObject}
      />
      <div className={styles.backlinks}>
        <NoteBacklinks objectRef={{ objectType: focusBlockId ? "note_block" : "page", objectId: focusBlockId ?? page.id }} />
      </div>
    </div>
  );
}

function newBlockId(): string {
  return crypto.randomUUID();
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

function flatPageBlockIds(page: NotePage): string[] {
  return flatBlockIds(page.blocks);
}

interface BlockWithChildren {
  id: string;
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
