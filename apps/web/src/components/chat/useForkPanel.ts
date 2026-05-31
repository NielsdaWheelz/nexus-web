"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { useStringIdSet } from "@/lib/useStringIdSet";
import {
  buildForkTree,
  collectExpandableIds,
  removeNode,
  updateNode,
} from "@/lib/conversations/forkTree";
import type { ConversationForkNode } from "@/lib/conversations/forkTree";
import type {
  ConversationForksResponse,
  BranchGraph,
  ForkOption,
} from "@/lib/conversations/types";

interface UseForkPanel {
  nodes: ConversationForkNode[];
  loading: boolean;
  error: string | null;
  query: string;
  setQuery: (query: string) => void;
  submitQuery: () => void;
  expandedIds: ReturnType<typeof useStringIdSet>;
  editingId: string | null;
  editingTitle: string;
  setEditingTitle: (title: string) => void;
  startRename: (fork: ConversationForkNode) => void;
  cancelRename: () => void;
  saveRename: (fork: ConversationForkNode) => Promise<void>;
  pendingDeleteId: string | null;
  requestDeleteFork: (fork: ConversationForkNode) => void;
  cancelDelete: () => void;
  confirmDeleteFork: (fork: ConversationForkNode) => Promise<void>;
}

export function useForkPanel(input: {
  conversationId: string;
  forkOptionsByParentId: Record<string, ForkOption[]>;
  branchGraph: BranchGraph;
  selectedPathMessageIds: Set<string>;
  onForksChanged?: () => void;
}): UseForkPanel {
  const {
    conversationId,
    forkOptionsByParentId,
    branchGraph,
    selectedPathMessageIds,
    onForksChanged,
  } = input;

  const fallbackNodes = useMemo(
    () => buildForkTree(Object.values(forkOptionsByParentId).flat(), branchGraph),
    [branchGraph, forkOptionsByParentId],
  );
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [nodes, setNodes] = useState<ConversationForkNode[]>(fallbackNodes);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expandedIds = useStringIdSet();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    setNodes(fallbackNodes);
  }, [fallbackNodes]);

  const { replace: replaceExpandedIds } = expandedIds;
  useEffect(() => {
    replaceExpandedIds(collectExpandableIds(nodes));
  }, [nodes, replaceExpandedIds]);

  const loadForks = useCallback(async () => {
    const loadSeq = loadSeqRef.current + 1;
    loadSeqRef.current = loadSeq;
    setLoading(true);
    setError(null);
    try {
      const params = submittedQuery
        ? `?${new URLSearchParams({ search: submittedQuery })}`
        : "";
      const response = await apiFetch<ConversationForksResponse>(
        `/api/conversations/${conversationId}/forks${params}`,
      );
      if (loadSeqRef.current !== loadSeq) return;
      setNodes(buildForkTree(response.data.forks, branchGraph));
    } catch (err) {
      if (loadSeqRef.current !== loadSeq) return;
      console.error("Failed to load forks:", err);
      setError("Fork search is unavailable.");
      setNodes(fallbackNodes);
    } finally {
      if (loadSeqRef.current === loadSeq) {
        setLoading(false);
      }
    }
  }, [branchGraph, conversationId, fallbackNodes, submittedQuery]);

  useEffect(() => {
    void loadForks();
  }, [loadForks]);

  const submitQuery = useCallback(() => {
    setSubmittedQuery(query.trim());
  }, [query]);

  const setQueryAndResetSubmitted = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    if (!nextQuery.trim()) {
      setSubmittedQuery("");
    }
  }, []);

  const startRename = useCallback((fork: ConversationForkNode) => {
    setEditingId(fork.id);
    setEditingTitle(fork.title ?? "");
  }, []);

  const cancelRename = useCallback(() => setEditingId(null), []);

  const saveRename = useCallback(
    async (fork: ConversationForkNode) => {
      const title = editingTitle.trim();
      try {
        await apiFetch(`/api/conversations/${conversationId}/forks/${fork.id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: title || null }),
        });
        setNodes((prev) => updateNode(prev, fork.id, { title: title || null }));
        setEditingId(null);
        setError(null);
        onForksChanged?.();
      } catch (err) {
        console.error("Failed to rename fork:", err);
        setError("Fork rename failed.");
      }
    },
    [conversationId, editingTitle, onForksChanged],
  );

  const requestDeleteFork = useCallback(
    (fork: ConversationForkNode) => {
      if (
        fork.active ||
        selectedPathMessageIds.has(fork.leaf_message_id) ||
        selectedPathMessageIds.has(fork.user_message_id) ||
        (fork.assistant_message_id
          ? selectedPathMessageIds.has(fork.assistant_message_id)
          : false)
      ) {
        setError("Switch away from this fork before deleting it.");
        return;
      }
      setError(null);
      setPendingDeleteId(fork.id);
    },
    [selectedPathMessageIds],
  );

  const cancelDelete = useCallback(() => setPendingDeleteId(null), []);

  const confirmDeleteFork = useCallback(
    async (fork: ConversationForkNode) => {
      try {
        await apiFetch(`/api/conversations/${conversationId}/forks/${fork.id}`, {
          method: "DELETE",
        });
        setNodes((prev) => removeNode(prev, fork.id));
        setPendingDeleteId(null);
        onForksChanged?.();
      } catch (err) {
        console.error("Failed to delete fork:", err);
        setError("Fork delete failed.");
      }
    },
    [conversationId, onForksChanged],
  );

  return {
    nodes,
    loading,
    error,
    query,
    setQuery: setQueryAndResetSubmitted,
    submitQuery,
    expandedIds,
    editingId,
    editingTitle,
    setEditingTitle,
    startRename,
    cancelRename,
    saveRename,
    pendingDeleteId,
    requestDeleteFork,
    cancelDelete,
    confirmDeleteFork,
  };
}
