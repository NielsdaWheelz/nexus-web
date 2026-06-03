"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { useStringIdSet } from "@/lib/useStringIdSet";
import {
  buildForkTree,
  collectExpandableIds,
  isForkInActivePath,
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
  activeLeafMessageId?: string | null;
  selectedPathMessageIds: Set<string>;
  onForksChanged?: () => void;
}): UseForkPanel {
  const {
    conversationId,
    forkOptionsByParentId,
    branchGraph,
    activeLeafMessageId,
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
  const [error, setError] = useState<string | null>(null);
  const expandedIds = useStringIdSet();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const forksPath = useMemo<ApiPath>(() => {
    const params = submittedQuery
      ? `?${new URLSearchParams({ search: submittedQuery })}`
      : "";
    return `/api/conversations/${conversationId}/forks${params}`;
  }, [conversationId, submittedQuery]);
  const forksResource = useResource<ConversationForksResponse>({
    cacheKey: forksPath,
    path: (path) => path as ApiPath,
  });

  useEffect(() => {
    setNodes(fallbackNodes);
  }, [fallbackNodes]);

  const { replace: replaceExpandedIds } = expandedIds;
  useEffect(() => {
    replaceExpandedIds(collectExpandableIds(nodes));
  }, [nodes, replaceExpandedIds]);

  useEffect(() => {
    if (forksResource.status === "loading") {
      setError(null);
      return;
    }
    if (forksResource.status === "ready") {
      setNodes(buildForkTree(forksResource.data.data.forks, branchGraph));
      setError(null);
      return;
    }
    if (forksResource.status === "error") {
      console.error("Failed to load forks:", forksResource.error);
      setError("Fork search is unavailable.");
      setNodes(fallbackNodes);
    }
  }, [branchGraph, fallbackNodes, forksResource]);

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
      if (isForkInActivePath(fork, { activeLeafMessageId, selectedPathMessageIds })) {
        setError("Switch away from this fork before deleting it.");
        return;
      }
      setError(null);
      setPendingDeleteId(fork.id);
    },
    [activeLeafMessageId, selectedPathMessageIds],
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
    loading: forksResource.status === "loading",
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
