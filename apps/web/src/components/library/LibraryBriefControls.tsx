"use client";

import { useCallback, type FormEvent } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type {
  ArtifactStatus,
  DossierRevision,
} from "@/components/library/dossierTypes";
import styles from "./LibraryBrief.module.css";

type DisplayEnvironment = ReturnType<typeof useRenderEnvironment>;

/** Machine-neutral status label for both the collapsed cue and the full line. */
export function dossierStatusLabel(
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
  const exhaustive: never = status;
  return exhaustive;
}

export function dossierStatusRole(
  status: ArtifactStatus,
): "alert" | "status" | undefined {
  if (status === "failed") return "alert";
  if (status === "building" || status === "stale") return "status";
  return undefined;
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
  display: DisplayEnvironment,
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

export function modelSummary(
  provider: string | null,
  name: string | null,
): string | null {
  if (provider && name) return `${provider}/${name}`;
  return provider ?? name;
}

export function previewInstruction(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return null;
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77)}...`;
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
  display: DisplayEnvironment | null;
}) {
  const generatedAt = display ? formatOptionalDate(createdAt, display) : null;
  const restoredAt = display ? formatOptionalDate(promotedAt, display) : null;
  const instruction = previewInstruction(customInstruction);
  const model = modelSummary(modelProvider, modelName);
  const coverage = coverageLabel(sourceCount, coveredSourceCount, omittedSourceCount);
  return (
    <>
      {citationCount !== null ? (
        <span className={styles.statusLabel}>{countLabel(citationCount, "citation")}</span>
      ) : null}
      {coverage ? <span className={styles.statusLabel}>{coverage}</span> : null}
      {generatedAt ? (
        <span className={styles.statusLabel}>{`Generated ${generatedAt}`}</span>
      ) : null}
      {restoredAt ? (
        <span className={styles.statusLabel}>{`Promoted ${restoredAt}`}</span>
      ) : null}
      {model ? <span className={styles.statusLabel}>{model}</span> : null}
      {totalTokens !== null ? (
        <span className={styles.statusLabel}>{countLabel(totalTokens, "token")}</span>
      ) : null}
      {instruction ? (
        <span className={styles.statusLabel}>{`Instruction: ${instruction}`}</span>
      ) : null}
    </>
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
  return (
    <div
      className={styles.statusLine}
      data-status={status}
      role={dossierStatusRole(status)}
    >
      <span className={styles.statusLabel}>
        {dossierStatusLabel(status, progress, staleSourceCount)}
      </span>
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
  revision: DossierRevision;
  citationCount: number | null;
  display: DisplayEnvironment;
}) {
  return (
    <div
      className={styles.statusLine}
      data-status={revision.status === "failed" ? "failed" : "current"}
      role={revision.status === "failed" ? "alert" : "status"}
    >
      <span className={styles.statusLabel}>
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
  showInstruction,
}: {
  status: ArtifactStatus;
  building: boolean;
  instruction: string;
  onInstructionChange: (instruction: string) => void;
  onGenerate: (instruction: string) => void;
  showInstruction: boolean;
}) {
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      onGenerate(instruction);
    },
    [instruction, onGenerate],
  );
  const isInitial = status === "unavailable";
  const label = status === "failed" ? "Retry" : isInitial ? "Generate dossier" : "Regenerate";
  return (
    <form className={styles.generateForm} onSubmit={handleSubmit}>
      {showInstruction ? (
        <Input
          size="sm"
          aria-label="Dossier instruction"
          value={instruction}
          onChange={(event) => onInstructionChange(event.target.value)}
          placeholder="Optional revision instruction"
          disabled={building}
        />
      ) : null}
      <Button
        type="submit"
        variant="ghost"
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

/**
 * Inline dossier controls: the status/coverage/model line (with its
 * `role=status`/`role=alert` live regions) plus the generate/regenerate/retry
 * form. A selected historical revision shows the revision status line and no
 * form; the pre-generation state shows a lone quiet "Generate dossier" button.
 */
export default function LibraryBriefControls({
  status,
  building,
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
  selectedRevision,
  revisionCitationCount,
  display,
  instruction,
  onInstructionChange,
  onGenerate,
}: {
  status: ArtifactStatus;
  building: boolean;
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
  selectedRevision: DossierRevision | null;
  revisionCitationCount: number | null;
  display: DisplayEnvironment;
  instruction: string;
  onInstructionChange: (instruction: string) => void;
  onGenerate: (instruction: string) => void;
}) {
  if (selectedRevision) {
    return (
      <RevisionStatusLine
        revision={selectedRevision}
        citationCount={revisionCitationCount}
        display={display}
      />
    );
  }
  const showStatusLine = status !== "unavailable";
  return (
    <>
      {showStatusLine ? (
        <StatusLine
          status={status}
          progress={progress}
          staleSourceCount={staleSourceCount}
          citationCount={citationCount}
          sourceCount={sourceCount}
          coveredSourceCount={coveredSourceCount}
          omittedSourceCount={omittedSourceCount}
          customInstruction={customInstruction}
          modelProvider={modelProvider}
          modelName={modelName}
          totalTokens={totalTokens}
        />
      ) : null}
      {status !== "building" ? (
        <GenerateDossierForm
          status={status}
          building={building}
          instruction={instruction}
          onInstructionChange={onInstructionChange}
          onGenerate={onGenerate}
          showInstruction={status !== "unavailable"}
        />
      ) : null}
    </>
  );
}
