"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MachineText from "@/components/ui/MachineText";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { useResource } from "@/lib/api/useResource";
import { useGenerationRun } from "@/lib/api/useGenerationRun";
import {
  toArtifactRevisionEvent,
  type ArtifactStreamEvent,
} from "@/lib/api/sse/artifactRevisionEvents";
import type { CitationOut } from "@/lib/conversations/citationOut";
import { toReaderCitationData } from "@/lib/conversations/citations";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import {
  activateResource,
  type ResourceActivation,
} from "@/lib/resources/activation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import styles from "./ConversationDistillate.module.css";

interface DistillateOut {
  artifact_id: string | null;
  revision_id: string | null;
  revision_ref: string | null;
  status: "unavailable" | "building" | "failed" | "stale" | "current";
  content_md: string;
  citations: CitationOut[];
  build: { revision_id: string; status: "building" | "ready" | "failed" } | null;
}

// Expand state persists across pane re-mounts, keyed by conversation (AC-10).
const expandedByConversation = new Map<string, boolean>();

export function useConversationDistillateExpanded(
  conversationId: string,
  forceOpen: boolean,
): readonly [boolean, (value: boolean) => void] {
  const [expanded, setExpandedState] = useState(
    () => forceOpen || expandedByConversation.get(conversationId) === true,
  );
  useEffect(() => {
    if (forceOpen) {
      expandedByConversation.set(conversationId, true);
      setExpandedState(true);
    }
  }, [forceOpen, conversationId]);
  const setExpanded = useCallback(
    (value: boolean) => {
      expandedByConversation.set(conversationId, value);
      setExpandedState(value);
    },
    [conversationId],
  );
  return [expanded, setExpanded] as const;
}

function firstLine(content: string): string {
  const trimmed = content.trim();
  const idx = trimmed.indexOf("\n");
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}

/**
 * The conversation distillate head block: one `MachineText` block (origin
 * `Distillate`) that appears once a conversation has been distilled. Quiet by
 * default (collapsed lede), expandable to the full grounded summary + claim
 * footnotes. Generated matter, marked as such; never touches the user's prose.
 * Streams over the shared generation-run plane (kind `artifact-revisions`).
 */
export default function ConversationDistillate({
  conversationId,
  reloadNonce = 0,
  forceExpand = false,
  navigate,
}: {
  conversationId: string;
  /** Parent bumps this after a `Distill` POST to refetch the (now building) head. */
  reloadNonce?: number;
  /** `?distillate=1` forces the block open and scrolls it into view (AC-10). */
  forceExpand?: boolean;
  navigate?: (href: string) => void;
}) {
  const [localNonce, setLocalNonce] = useState(0);
  const resource = useResource<{ data: DistillateOut }>({
    cacheKey: `distillate:${conversationId}:${reloadNonce}:${localNonce}`,
    path: () => `/api/conversations/${conversationId}/distillate`,
  });
  const distillate = resource.status === "ready" ? resource.data.data : null;

  const [revisionId, setRevisionId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useConversationDistillateExpanded(
    conversationId,
    forceExpand,
  );

  // Resume an in-flight build (opened mid-generation): subscribe to the draft.
  const inFlightRevisionId =
    distillate?.status === "building"
      ? distillate.build?.revision_id ?? distillate.revision_id ?? null
      : null;
  useEffect(() => {
    if (inFlightRevisionId !== null) setRevisionId(inFlightRevisionId);
  }, [inFlightRevisionId]);

  const onEvent = useCallback((event: ArtifactStreamEvent) => {
    if (event.type === "done") {
      setRevisionId(null);
      setLocalNonce((n) => n + 1);
    }
  }, []);
  useGenerationRun<ArtifactStreamEvent>({
    kind: "artifact-revisions",
    id: revisionId,
    decode: toArtifactRevisionEvent,
    isTerminal: (event) => event.type === "done",
    onEvent,
  });

  const citations = useMemo(
    () => (distillate?.citations ?? []).map(toReaderCitationData),
    [distillate],
  );

  const activate = useCallback(
    (
      activation: ResourceActivation,
      target: ReaderSourceTarget | null,
      event?: React.MouseEvent,
    ) => {
      if (target) dispatchReaderSourceActivation(target);
      activateResource(activation, {
        label: target?.label,
        navigate,
        newPane: event?.shiftKey === true,
      });
    },
    [navigate],
  );

  const building = revisionId !== null || distillate?.status === "building";
  const hasContent =
    distillate !== null &&
    distillate.content_md.trim().length > 0 &&
    (distillate.status === "current" || distillate.status === "stale");

  useEffect(() => {
    if (forceExpand && hasContent) {
      containerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [forceExpand, hasContent]);

  // Present-but-quiet: nothing at all until there is a build or a distillate.
  if (!building && !hasContent) return null;

  return (
    <div
      ref={containerRef}
      className={styles.distillate}
      data-testid="conversation-distillate"
    >
      <MachineText origin={{ label: "Distillate" }} className={styles.body}>
        {hasContent ? (
          expanded ? (
            <MarkdownMessage
              content={distillate!.content_md}
              citations={citations}
              onCitationActivate={activate}
            />
          ) : (
            <p>{firstLine(distillate!.content_md)}</p>
          )
        ) : (
          <p>Distilling this conversation…</p>
        )}
      </MachineText>
      {hasContent ? (
        <button
          type="button"
          className={styles.expander}
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? "Collapse" : "Show distillate"}
        </button>
      ) : null}
    </div>
  );
}
