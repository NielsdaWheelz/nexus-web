"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { MessageSquare, RefreshCw, Sparkles } from "lucide-react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { apiFetch } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { CitationOut } from "@/lib/conversations/citationOut";
import { toReaderCitationData } from "@/lib/conversations/citations";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import { formatDisplayDate } from "@/lib/display/format";
import {
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import {
  activateResource,
  type ResourceActivation,
} from "@/lib/resources/activation";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useLibraryIntelligenceStream } from "@/components/library/useLibraryIntelligenceStream";
import ResourceChatDetail from "@/components/chat/ResourceChatDetail";
import styles from "./page.module.css";

type ArtifactStatus =
  | "unavailable"
  | "building"
  | "failed"
  | "stale"
  | "current";

interface LibraryIntelligenceBuild {
  revision_id: string;
  status: "building" | "ready" | "failed";
}

interface LibraryIntelligenceArtifact {
  artifact_id: string | null;
  artifact_ref: string | null;
  revision_id: string | null;
  revision_ref: string | null;
  status: ArtifactStatus;
  content_md: string;
  citations: CitationOut[];
  stale_source_count: number | null;
  citation_count: number;
  source_count: number;
  covered_source_count: number;
  omitted_source_count: number;
  custom_instruction?: string | null;
  model_provider?: string | null;
  model_name?: string | null;
  total_tokens?: number | null;
  build: LibraryIntelligenceBuild | null;
}

interface LibraryIntelligenceRevision {
  artifact_id: string;
  artifact_ref: string;
  revision_id: string;
  revision_ref: string;
  status: "building" | "ready" | "failed";
  content_md: string;
  citations: CitationOut[];
  created_at: string;
  promoted_at: string | null;
  is_current: boolean;
  citation_count: number;
  source_count: number;
  covered_source_count: number;
  omitted_source_count: number;
  custom_instruction?: string | null;
  model_provider?: string | null;
  model_name?: string | null;
  total_tokens?: number | null;
}

interface RevisionSummary {
  artifact_id: string;
  artifact_ref: string;
  revision_id: string;
  revision_ref: string;
  status: "building" | "ready" | "failed";
  created_at: string;
  promoted_at: string | null;
  is_current: boolean;
  citation_count: number;
  source_count: number;
  covered_source_count: number;
  omitted_source_count: number;
  custom_instruction?: string | null;
  model_provider?: string | null;
  model_name?: string | null;
  total_tokens?: number | null;
}

export default function LibraryIntelligencePane({ libraryId }: { libraryId: string }) {
  const display = useRenderEnvironment();
  const router = usePaneRouter();
  const selectedRevisionId = usePaneSearchParams().get("revision");
  const paneRuntime = usePaneRuntime();
  const openInNewPane = paneRuntime?.openInNewPane;
  const [reloadNonce, setReloadNonce] = useState(0);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [instruction, setInstruction] = useState("");
  const [chatOpen, setChatOpen] = useState(false);

  const reload = useCallback(() => {
    // justify: single refetch on terminal SSE event, not polling
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
    setError(
      toFeedback(streamError, {
        fallback: "Library dossier stream failed",
      }),
    );
  }, []);

  const { building, progress, generate, subscribe } =
    useLibraryIntelligenceStream({
      libraryId,
      onDone: handleDone,
      onError: handleStreamError,
    });

  const artifactResource = useResource<{ data: LibraryIntelligenceArtifact }>({
    cacheKey: `library-intelligence:${libraryId}:${reloadNonce}`,
    path: () => `/api/libraries/${libraryId}/intelligence`,
  });

  const artifact =
    artifactResource.status === "ready" ? artifactResource.data.data : null;
  const revisionResource = useResource<{ data: LibraryIntelligenceRevision }>({
    cacheKey:
      selectedRevisionId === null
        ? null
        : `library-intelligence-revision:${libraryId}:${selectedRevisionId}:${reloadNonce}`,
    path: () =>
      `/api/libraries/${libraryId}/intelligence/revisions/${selectedRevisionId}`,
  });
  const selectedRevision =
    revisionResource.status === "ready" ? revisionResource.data.data : null;

  // Resume an in-flight build (e.g. opened mid-generation): subscribe to the
  // draft revision's stream when the GET reports a building draft. The hook
  // itself dedupes a repeat subscribe to the same revision id.
  const inFlightRevisionId =
    artifact?.status === "building" ? artifact.build?.revision_id ?? null : null;
  useEffect(() => {
    if (inFlightRevisionId !== null) {
      void subscribe(inFlightRevisionId);
    }
  }, [inFlightRevisionId, subscribe]);

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
  const handleOpenFullChat = useCallback(
    (conversationId: string) => {
      const href = `/conversations/${conversationId}`;
      if (openInNewPane) {
        openInNewPane(href, "Dossier chat");
        return;
      }
      router.push(href);
    },
    [openInNewPane, router],
  );

  if (artifactResource.status === "loading" && !artifact) {
    return <PaneLoadingState label="Loading dossier…" />;
  }

  if (artifactResource.status === "error") {
    return (
      <div className={styles.intelligencePane}>
        <FeedbackNotice
          {...toFeedback(artifactResource.error, {
            fallback: "Failed to load library dossier",
          })}
        />
      </div>
    );
  }

  if (!artifact) {
    return <PaneLoadingState label="Loading dossier…" />;
  }
  if (selectedRevisionId !== null && revisionResource.status === "loading") {
    return <PaneLoadingState label="Loading revision…" />;
  }
  if (selectedRevisionId !== null && revisionResource.status === "error") {
    return (
      <div className={styles.intelligencePane}>
        <FeedbackNotice
          {...toFeedback(revisionResource.error, {
            fallback: "Failed to load dossier revision",
          })}
        />
      </div>
    );
  }

  const artifactId = artifact.artifact_id;
  const displayedContent = selectedRevision?.content_md ?? artifact.content_md;
  const displayedCitations = selectedRevision?.citations ?? artifact.citations;
  const displayedMetadata = selectedRevision ?? artifact;
  const chatRevisionRef = selectedRevision?.revision_ref ?? artifact.revision_ref;
  // The status reflects the head; a live SSE build overrides a stale/current
  // head so the in-flight regenerate shows "Generating…" immediately.
  const status: ArtifactStatus = building ? "building" : artifact.status;
  const hasContent = displayedContent.trim().length > 0;
  const citationCount = visibleCitationCount(displayedMetadata, displayedCitations);

  if (chatOpen && chatRevisionRef) {
    return (
      <div className={styles.intelligencePane}>
        <ResourceChatDetail
          conversationId={null}
          subjectRef={chatRevisionRef}
          onBack={() => setChatOpen(false)}
          onOpenFullChat={handleOpenFullChat}
          onReaderSourceActivate={activate}
        />
      </div>
    );
  }

  return (
    <div className={styles.intelligencePane}>
      <div className={styles.intelligenceHeader}>
        <div className={styles.intelligenceTitleGroup}>
          <h2 className={styles.intelligenceTitle}>Dossier</h2>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setChatOpen(true)}
          disabled={chatRevisionRef === null}
          leadingIcon={<MessageSquare size={16} aria-hidden="true" />}
        >
          Chat
        </Button>
      </div>

      {error ? <FeedbackNotice {...error} /> : null}

      {selectedRevision === null ? (
        <>
          <StatusLine
            status={status}
            progress={progress}
            staleSourceCount={artifact.stale_source_count}
            citationCount={hasContent ? citationCount : artifact.citation_count}
            sourceCount={artifact.source_count}
            coveredSourceCount={artifact.covered_source_count}
            omittedSourceCount={artifact.omitted_source_count}
            customInstruction={artifact.custom_instruction ?? null}
            modelProvider={artifact.model_provider ?? null}
            modelName={artifact.model_name ?? null}
            totalTokens={artifact.total_tokens ?? null}
          />
          {status !== "building" ? (
            <GenerateDossierForm
              status={status}
              building={building}
              instruction={instruction}
              onInstructionChange={setInstruction}
              onGenerate={handleGenerate}
            />
          ) : null}
        </>
      ) : (
        <RevisionStatusLine
          revision={selectedRevision}
          citationCount={citationCount}
          display={display}
        />
      )}

      {status === "unavailable" && !hasContent ? (
        <FeedbackNotice
          severity="neutral"
          title="No dossier has been generated yet."
        />
      ) : hasContent ? (
        <div className={styles.intelligenceBody}>
          <MarkdownMessage
            content={displayedContent}
            citations={citations}
            onCitationActivate={activate}
          />
        </div>
      ) : null}

      {artifactId ? (
        <RevisionHistory
          libraryId={libraryId}
          display={display}
          selectedRevisionId={selectedRevisionId}
          onRestored={reload}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function StatusLine({
  status,
  progress,
  staleSourceCount,
  citationCount,
  sourceCount,
  coveredSourceCount,
  omittedSourceCount,
  customInstruction,
  modelProvider,
  modelName,
  totalTokens,
}: {
  status: ArtifactStatus;
  progress: string | null;
  staleSourceCount: number | null;
  citationCount: number | null;
  sourceCount: number | null;
  coveredSourceCount: number | null;
  omittedSourceCount: number | null;
  customInstruction: string | null;
  modelProvider: string | null;
  modelName: string | null;
  totalTokens: number | null;
}) {
  const label = statusLabel(status, progress, staleSourceCount);
  return (
    <div
      className={styles.intelligenceStatusLine}
      data-status={status}
      role={statusRole(status)}
    >
      <span className={styles.intelligenceStatusLabel}>{label}</span>
      <DossierMetadata
        citationCount={citationCount}
        sourceCount={sourceCount}
        coveredSourceCount={coveredSourceCount}
        omittedSourceCount={omittedSourceCount}
        createdAt={null}
        promotedAt={null}
        customInstruction={customInstruction}
        modelProvider={modelProvider}
        modelName={modelName}
        totalTokens={totalTokens}
        display={null}
      />
    </div>
  );
}

function RevisionStatusLine({
  revision,
  citationCount,
  display,
}: {
  revision: LibraryIntelligenceRevision;
  citationCount: number | null;
  display: ReturnType<typeof useRenderEnvironment>;
}) {
  return (
    <div
      className={styles.intelligenceStatusLine}
      data-status={revision.status === "failed" ? "failed" : "current"}
      role={revision.status === "failed" ? "alert" : "status"}
    >
      <span className={styles.intelligenceStatusLabel}>
        {revision.is_current ? "Current revision" : "Historical revision"}
      </span>
      <DossierMetadata
        citationCount={citationCount}
        sourceCount={revision.source_count ?? null}
        coveredSourceCount={revision.covered_source_count ?? null}
        omittedSourceCount={revision.omitted_source_count ?? null}
        createdAt={revision.created_at}
        promotedAt={revision.promoted_at}
        customInstruction={revision.custom_instruction ?? null}
        modelProvider={revision.model_provider ?? null}
        modelName={revision.model_name ?? null}
        totalTokens={revision.total_tokens ?? null}
        display={display}
      />
    </div>
  );
}

function GenerateDossierForm({
  status,
  building,
  instruction,
  onInstructionChange,
  onGenerate,
}: {
  status: ArtifactStatus;
  building: boolean;
  instruction: string;
  onInstructionChange: (instruction: string) => void;
  onGenerate: (instruction: string) => void;
}) {
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      onGenerate(instruction);
    },
    [instruction, onGenerate],
  );
  const isInitial = status === "unavailable";
  const label =
    status === "failed" ? "Retry" : isInitial ? "Generate Dossier" : "Regenerate";
  return (
    <form className={styles.intelligenceStatusLine} onSubmit={handleSubmit}>
      <Input
        aria-label="Dossier instruction"
        value={instruction}
        onChange={(event) => onInstructionChange(event.target.value)}
        placeholder="Optional revision instruction"
        disabled={building}
      />
      <Button
        type="submit"
        variant={isInitial ? "primary" : "secondary"}
        size="sm"
        disabled={building}
        leadingIcon={
          isInitial ? (
            <Sparkles size={16} aria-hidden="true" />
          ) : (
            <RefreshCw size={16} aria-hidden="true" />
          )
        }
      >
        {label}
      </Button>
    </form>
  );
}

function DossierMetadata({
  citationCount,
  sourceCount,
  coveredSourceCount,
  omittedSourceCount,
  createdAt,
  promotedAt,
  customInstruction,
  modelProvider,
  modelName,
  totalTokens,
  display,
}: {
  citationCount: number | null;
  sourceCount: number | null;
  coveredSourceCount: number | null;
  omittedSourceCount: number | null;
  createdAt: string | null;
  promotedAt: string | null;
  customInstruction: string | null;
  modelProvider: string | null;
  modelName: string | null;
  totalTokens: number | null;
  display: ReturnType<typeof useRenderEnvironment> | null;
}) {
  const generatedAt = display ? formatOptionalDate(createdAt, display) : null;
  const restoredAt = display ? formatOptionalDate(promotedAt, display) : null;
  const instruction = previewInstruction(customInstruction);
  const model = modelSummary(modelProvider, modelName);
  const coverage = coverageLabel(sourceCount, coveredSourceCount, omittedSourceCount);
  return (
    <>
      {citationCount !== null ? (
        <span className={styles.intelligenceStatusLabel}>
          {countLabel(citationCount, "citation")}
        </span>
      ) : null}
      {coverage ? (
        <span className={styles.intelligenceStatusLabel}>{coverage}</span>
      ) : null}
      {generatedAt ? (
        <span className={styles.intelligenceStatusLabel}>
          {`Generated ${generatedAt}`}
        </span>
      ) : null}
      {restoredAt ? (
        <span className={styles.intelligenceStatusLabel}>
          {`Promoted ${restoredAt}`}
        </span>
      ) : null}
      {model ? (
        <span className={styles.intelligenceStatusLabel}>{model}</span>
      ) : null}
      {totalTokens !== null ? (
        <span className={styles.intelligenceStatusLabel}>
          {countLabel(totalTokens, "token")}
        </span>
      ) : null}
      {instruction ? (
        <span className={styles.intelligenceStatusLabel}>
          {`Instruction: ${instruction}`}
        </span>
      ) : null}
    </>
  );
}

function statusLabel(
  status: ArtifactStatus,
  progress: string | null,
  staleSourceCount: number | null,
): string {
  switch (status) {
    case "current":
      return "Current";
    case "stale":
      return staleSourceCount === null
        ? "Stale"
        : `Stale — ${staleSourceCount} ${
            staleSourceCount === 1 ? "source" : "sources"
          } changed`;
    case "building":
      return progress ? `Generating… ${progress}` : "Generating…";
    case "failed":
      return "Failed";
    case "unavailable":
      return "Unavailable";
  }
  const _exhaustive: never = status;
  return _exhaustive;
}

function statusRole(status: ArtifactStatus): "alert" | "status" | undefined {
  if (status === "failed") return "alert";
  if (status === "building" || status === "stale") return "status";
  return undefined;
}

function visibleCitationCount(
  metadata: { citation_count?: number | null },
  citations: readonly CitationOut[],
): number | null {
  if (typeof metadata.citation_count === "number") {
    return metadata.citation_count;
  }
  return citations.length;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function coverageLabel(
  sourceCount: number | null,
  coveredSourceCount: number | null,
  omittedSourceCount: number | null,
): string | null {
  if (sourceCount === null || sourceCount === 0) return null;
  const covered = coveredSourceCount ?? sourceCount;
  const omitted = omittedSourceCount ?? Math.max(sourceCount - covered, 0);
  if (omitted > 0) {
    return `${covered} of ${sourceCount} sources covered (${omitted} omitted)`;
  }
  return `${countLabel(covered, "source")} covered`;
}

function formatOptionalDate(
  value: string | null,
  display: ReturnType<typeof useRenderEnvironment>,
): string | null {
  if (!value) return null;
  return (
    formatDisplayDate(value, display, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }) ?? value
  );
}

function modelSummary(provider: string | null, name: string | null): string | null {
  if (provider && name) return `${provider}/${name}`;
  return provider ?? name;
}

function previewInstruction(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return null;
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77)}...`;
}

function RevisionHistory({
  libraryId,
  display,
  selectedRevisionId,
  onRestored,
  onError,
}: {
  libraryId: string;
  display: ReturnType<typeof useRenderEnvironment>;
  selectedRevisionId: string | null;
  onRestored: () => void;
  onError: (feedback: FeedbackContent) => void;
}) {
  const router = usePaneRouter();
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<RevisionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const loadRevisions = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch<{ data: { revisions: RevisionSummary[] } }>(
        `/api/libraries/${libraryId}/intelligence/revisions`,
      );
      setRevisions(response.data.revisions);
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      onError(toFeedback(err, { fallback: "Failed to load revision history" }));
    } finally {
      setLoading(false);
    }
  }, [libraryId, onError]);

  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      if (next && revisions === null && !loading) {
        void loadRevisions();
      }
      return next;
    });
  }, [loadRevisions, loading, revisions]);

  const restore = useCallback(
    async (revisionId: string) => {
      setRestoringId(revisionId);
      try {
        await apiFetch(
          `/api/libraries/${libraryId}/intelligence/revisions/${revisionId}/promote`,
          { method: "POST" },
        );
        await loadRevisions();
        onRestored();
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        onError(toFeedback(err, { fallback: "Failed to restore revision" }));
      } finally {
        setRestoringId(null);
      }
    },
    [libraryId, loadRevisions, onError, onRestored],
  );
  const openRevision = useCallback(
    (revisionId: string) => {
      router.push(`/libraries/${libraryId}?tab=intelligence&revision=${revisionId}`);
    },
    [libraryId, router],
  );

  return (
    <div className={styles.intelligenceHistory}>
      <button
        type="button"
        className={styles.intelligenceHistoryToggle}
        aria-expanded={open}
        onClick={toggle}
      >
        Dossier history
      </button>
      {open ? (
        loading ? (
          <PaneLoadingState label="Loading history…" />
        ) : revisions && revisions.length > 0 ? (
          <ul className={styles.intelligenceHistoryList}>
            {revisions.map((revision) => (
              <RevisionHistoryItem
                key={revision.revision_id}
                revision={revision}
                display={display}
                selectedRevisionId={selectedRevisionId}
                restoringId={restoringId}
                onOpen={openRevision}
                onRestore={restore}
              />
            ))}
          </ul>
        ) : (
          <p className={styles.intelligenceHistoryEmpty}>No revisions yet.</p>
        )
      ) : null}
    </div>
  );
}

function RevisionHistoryItem({
  revision,
  display,
  selectedRevisionId,
  restoringId,
  onOpen,
  onRestore,
}: {
  revision: RevisionSummary;
  display: ReturnType<typeof useRenderEnvironment>;
  selectedRevisionId: string | null;
  restoringId: string | null;
  onOpen: (revisionId: string) => void;
  onRestore: (revisionId: string) => Promise<void>;
}) {
  const coverage = coverageLabel(
    revision.source_count,
    revision.covered_source_count,
    revision.omitted_source_count,
  );
  const model = modelSummary(
    revision.model_provider ?? null,
    revision.model_name ?? null,
  );
  const instruction = previewInstruction(revision.custom_instruction ?? null);
  return (
    <li className={styles.intelligenceHistoryItem}>
      <span className={styles.intelligenceHistoryMeta}>
        {formatDisplayDate(revision.created_at, display, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }) ?? revision.created_at}
        {" · "}
        {revision.status}
        {" · "}
        {countLabel(revision.citation_count, "citation")}
        {coverage ? (
          <>
            {" · "}
            {coverage}
          </>
        ) : null}
        {model ? (
          <>
            {" · "}
            {model}
          </>
        ) : null}
        {revision.total_tokens ? (
          <>
            {" · "}
            {countLabel(revision.total_tokens, "token")}
          </>
        ) : null}
        {instruction ? (
          <>
            {" · "}
            {`Instruction: ${instruction}`}
          </>
        ) : null}
        {revision.is_current ? (
          <span className={styles.intelligenceHistoryBadge}>Current</span>
        ) : null}
        {revision.revision_id === selectedRevisionId ? (
          <span className={styles.intelligenceHistoryBadge}>Viewing</span>
        ) : null}
      </span>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => onOpen(revision.revision_id)}
        disabled={revision.revision_id === selectedRevisionId}
      >
        Open
      </Button>
      {!revision.is_current && revision.status === "ready" ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void onRestore(revision.revision_id)}
          disabled={restoringId !== null}
        >
          Restore
        </Button>
      ) : null}
    </li>
  );
}
