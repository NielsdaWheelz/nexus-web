"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { CitationOut } from "@/lib/conversations/citationOut";
import { toReaderCitationData } from "@/lib/conversations/citations";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import {
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import {
  activateResource,
  type ResourceActivation,
} from "@/lib/resources/activation";
import { startResourceChat } from "@/lib/resources/resourceChat";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useArtifactStream } from "@/components/library/useArtifactStream";
import type {
  ArtifactStatus,
  DossierArtifact,
  DossierRevision,
} from "@/components/library/dossierTypes";
import { deriveDossierLede } from "@/lib/library/dossierLede";
import LibraryBriefLede from "./LibraryBriefLede";
import LibraryBriefArtifact from "./LibraryBriefArtifact";
import LibraryBriefControls from "./LibraryBriefControls";
import LibraryBriefRevisions from "./LibraryBriefRevisions";
import styles from "./LibraryBrief.module.css";

function visibleCitationCount(
  metadata: { citation_count?: number | null },
  citations: readonly CitationOut[],
): number | null {
  if (typeof metadata.citation_count === "number") {
    return metadata.citation_count;
  }
  return citations.length;
}

/**
 * The library's machine-authored brief, rendered in place above the entry list
 * (machine-output-in-place D-1). Owns the artifact/revision fetch, the
 * unchanged SSE build stream, the expand state, and the `?tab`/`?revision`
 * deep links. A library with no dossier renders no machine voice — only the
 * lone quiet "Generate dossier" button (D-2).
 */
export default function LibraryBrief({ libraryId }: { libraryId: string }) {
  const display = useRenderEnvironment();
  const router = usePaneRouter();
  const paneSearchParams = usePaneSearchParams();
  const selectedTab = paneSearchParams.get("tab");
  const selectedRevisionId = paneSearchParams.get("revision");
  const openInNewPane = usePaneRuntime()?.openInNewPane;
  const fullBodyId = useId();
  const fullBodyRef = useRef<HTMLDivElement | null>(null);

  const [reloadNonce, setReloadNonce] = useState(0);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [instruction, setInstruction] = useState("");
  const [expanded, setExpanded] = useState(false);

  const reload = useCallback(() => {
    setReloadNonce((nonce) => nonce + 1);
  }, []);

  const handleDone = useCallback(
    (_revisionId: string, doneError: string | null) => {
      if (doneError !== null) {
        setError({ severity: "error", title: "Generation failed" });
      }
      reload();
    },
    [reload],
  );

  const handleStreamError = useCallback((streamError: Error) => {
    setError(toFeedback(streamError, { fallback: "Library dossier stream failed" }));
  }, []);

  const { building, progress, generate, subscribe } = useArtifactStream({
    libraryId,
    onDone: handleDone,
    onError: handleStreamError,
  });

  const artifactResource = useResource<{ data: DossierArtifact }>({
    cacheKey: `library-dossier:${libraryId}:${reloadNonce}`,
    path: () => `/api/libraries/${libraryId}/intelligence`,
  });
  const artifact =
    artifactResource.status === "ready" ? artifactResource.data.data : null;

  const revisionResource = useResource<{ data: DossierRevision }>({
    cacheKey:
      selectedRevisionId === null
        ? null
        : `library-dossier-revision:${libraryId}:${selectedRevisionId}:${reloadNonce}`,
    path: () =>
      `/api/libraries/${libraryId}/intelligence/revisions/${selectedRevisionId}`,
  });
  const selectedRevision =
    revisionResource.status === "ready" ? revisionResource.data.data : null;

  // Resume an in-flight build (opened mid-generation): subscribe to the draft
  // revision when the GET reports a building draft. The hook dedupes repeats.
  const inFlightRevisionId =
    artifact?.status === "building" ? artifact.build?.revision_id ?? null : null;
  useEffect(() => {
    if (inFlightRevisionId !== null) {
      void subscribe(inFlightRevisionId);
    }
  }, [inFlightRevisionId, subscribe]);

  // Deep links: `?tab=intelligence` (or a selected revision) opens the brief
  // expanded; the tab param also scrolls it into view.
  useEffect(() => {
    if (selectedTab === "intelligence" || selectedRevisionId !== null) {
      setExpanded(true);
    }
  }, [selectedTab, selectedRevisionId]);
  useEffect(() => {
    if (expanded && selectedTab === "intelligence") {
      fullBodyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [expanded, selectedTab]);

  const citations = useMemo(
    () =>
      (selectedRevision?.citations ?? artifact?.citations ?? []).map(
        toReaderCitationData,
      ),
    [artifact, selectedRevision],
  );

  const activate = useCallback(
    (
      activation: ResourceActivation,
      target: ReaderSourceTarget | null,
      event?: React.MouseEvent,
    ) => {
      if (target) dispatchReaderSourceActivation(target);
      if (event?.shiftKey) {
        activateResource(activation, {
          label: target?.label,
          openInNewPane,
          newPane: true,
        });
        return;
      }
      activateResource(activation, {
        label: target?.label,
        navigate: (href) => router.push(href),
      });
    },
    [openInNewPane, router],
  );

  const handleGenerate = useCallback(
    (nextInstruction: string) => {
      setError(null);
      void generate(nextInstruction);
    },
    [generate],
  );

  const chatRevisionRef = selectedRevision?.revision_ref ?? artifact?.revision_ref ?? null;
  const handleChat = useCallback(async () => {
    if (chatRevisionRef === null) return;
    setError(null);
    try {
      const conversationId = await startResourceChat(chatRevisionRef);
      const href = `/conversations/${conversationId}`;
      if (openInNewPane) {
        openInNewPane(href, "Dossier chat");
      } else {
        router.push(href);
      }
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setError(toFeedback(err, { fallback: "Failed to open dossier chat" }));
    }
  }, [chatRevisionRef, openInNewPane, router]);

  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);

  if (artifactResource.status === "loading" && !artifact) {
    return null;
  }
  if (artifactResource.status === "error") {
    return (
      <FeedbackNotice
        {...toFeedback(artifactResource.error, {
          fallback: "Failed to load library dossier",
        })}
      />
    );
  }
  if (!artifact) {
    return null;
  }

  const displayedContent = selectedRevision?.content_md ?? artifact.content_md;
  const displayedCitations = selectedRevision?.citations ?? artifact.citations;
  const displayedMetadata = selectedRevision ?? artifact;
  // A live SSE build overrides a stale/current head so an in-flight regenerate
  // shows "Generating…" immediately.
  const status: ArtifactStatus = building ? "building" : artifact.status;
  const hasContent = displayedContent.trim().length > 0;
  const citationCount = hasContent
    ? visibleCitationCount(displayedMetadata, displayedCitations)
    : artifact.citation_count;
  const lede = deriveDossierLede(displayedContent);

  const controls = (
    <LibraryBriefControls
      status={status}
      building={building}
      progress={progress}
      staleSourceCount={artifact.stale_source_count}
      citationCount={citationCount}
      sourceCount={artifact.source_count}
      coveredSourceCount={artifact.covered_source_count}
      omittedSourceCount={artifact.omitted_source_count}
      customInstruction={artifact.custom_instruction ?? null}
      modelProvider={artifact.model_provider ?? null}
      modelName={artifact.model_name ?? null}
      totalTokens={artifact.total_tokens ?? null}
      selectedRevision={selectedRevision}
      revisionCitationCount={
        selectedRevision ? visibleCitationCount(selectedRevision, displayedCitations) : null
      }
      display={display}
      instruction={instruction}
      onInstructionChange={setInstruction}
      onGenerate={handleGenerate}
    />
  );

  // Silence: no dossier and nothing streaming — only the lone generate control.
  if (!hasContent && !building) {
    return (
      <section className={styles.brief} aria-label="Library dossier">
        {error ? <FeedbackNotice {...error} /> : null}
        {controls}
      </section>
    );
  }

  return (
    <section className={styles.brief} aria-label="Library dossier">
      {error ? <FeedbackNotice {...error} /> : null}
      <LibraryBriefLede
        lede={lede}
        status={status}
        progress={progress}
        staleSourceCount={artifact.stale_source_count}
        expandable={hasContent}
        expanded={expanded}
        fullBodyId={fullBodyId}
        onToggle={toggleExpanded}
      />
      {expanded ? (
        <div id={fullBodyId} ref={fullBodyRef} className={styles.full}>
          {controls}
          <LibraryBriefArtifact
            content={displayedContent}
            citations={citations}
            onCitationActivate={activate}
            onChat={() => void handleChat()}
            chatDisabled={chatRevisionRef === null}
          />
          {artifact.artifact_id ? (
            <LibraryBriefRevisions
              libraryId={libraryId}
              selectedRevisionId={selectedRevisionId}
              onRestored={reload}
              onError={setError}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
