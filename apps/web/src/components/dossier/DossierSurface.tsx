"use client";

// The Dossier surface (A14/A15): the sole `resource-dossier` body. It owns the
// build lifecycle UI for EVERY A15 state — never-generated, head-loading/failed,
// building, regenerating (current preserved), suspended (+Cancel), current,
// stale, historical, failed, cancelled — driven entirely by the pure
// `deriveDossierViewModel` over the external controller store. Stream tokens
// mutate the store (this leaf re-renders per token); the pane's publication body
// stays reference-stable, so the PRIMARY pane never re-renders per token.
//
// Accessibility contract: ONE polite status region for progress/cancellation; a
// terminal build failure is a visible `role="alert"` + Retry that does NOT move
// focus; a synchronous command error sits near the control, also without moving
// focus (A14).
import { useEffect } from "react";
import { GitBranch, RotateCcw, X } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import MachineText from "@/components/ui/MachineText";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import { toReaderCitationData } from "@/lib/conversations/citations";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import {
  useDossierSelector,
  type DossierControllerStore,
} from "@/lib/dossiers/dossierControllerStore";
import MediaAbstract from "@/components/dossier/MediaAbstract";
import {
  deriveDossierViewModel,
  type DossierActivityView,
  type DossierBodyView,
  type DossierViewModel,
} from "@/components/dossier/dossierViewModel";
import { dossierCoverageLabel } from "@/components/dossier/dossierCoverage";
import styles from "./DossierSurface.module.css";

export type DossierCitationActivate = (
  activation: ResourceActivation,
  target: ReaderSourceTarget | null,
  event?: React.MouseEvent,
) => void;

interface DossierSurfaceProps {
  store: DossierControllerStore;
  onViewMediaEvidence: () => void;
  /** Wired by the pane/controller to route citation clicks through the pane
   * router; defaults to reader-source dispatch for in-document targets. */
  onCitationActivate?: DossierCitationActivate;
}

const defaultCitationActivate: DossierCitationActivate = (_activation, target) => {
  if (target) dispatchReaderSourceActivation(target);
};

export default function DossierSurface({
  store,
  onViewMediaEvidence,
  onCitationActivate = defaultCitationActivate,
}: DossierSurfaceProps) {
  // A14: connect on mount / disconnect the CLIENT stream on unmount — the
  // durable build continues; remount refetches the head and resumes.
  useEffect(() => {
    store.attach();
    return () => store.detach();
  }, [store]);

  const vm = useDossierSelector(store, deriveDossierViewModel);
  const instructionDraft = useDossierSelector(
    store,
    (state) => state.instructionDraft,
  );
  const busy = vm.controls.busy !== null;
  const canStartGeneration =
    vm.controls.canGenerate || vm.controls.canRegenerate;
  const submitInstruction = () => {
    const instruction = instructionDraft.trim();
    if (vm.controls.canGenerate) {
      store.generate(instruction || null);
    } else if (vm.controls.canRegenerate) {
      store.regenerate(instruction || null);
    }
  };

  return (
    <div className={styles.surface} data-testid="resource-dossier-surface">
      <div className={styles.statusRegion} role="status" aria-live="polite">
        {vm.statusMessage}
      </div>

      {vm.mediaAbstract ? (
        <MediaAbstract
          abstract={vm.mediaAbstract}
          onViewEvidence={onViewMediaEvidence}
        />
      ) : null}

      <ActivityBanner activity={vm.activity} />

      {vm.alert ? (
        <div className={`${styles.banner} ${styles.bannerAlert}`} role="alert">
          <span>{vm.alert.message}</span>
        </div>
      ) : null}

      {canStartGeneration ? (
        <form
          className={styles.generationForm}
          onSubmit={(event) => {
            event.preventDefault();
            submitInstruction();
          }}
        >
          <label className={styles.instructionField}>
            <span>Optional instruction</span>
            <Input
              size="sm"
              maxLength={4000}
              value={instructionDraft}
              onChange={(event) =>
                store.setInstructionDraft(event.currentTarget.value)
              }
              disabled={busy}
              placeholder="What should this dossier emphasize?"
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={busy}
          >
            {vm.controls.canGenerate ? "Generate dossier" : "Regenerate"}
          </Button>
        </form>
      ) : null}

      <div className={styles.controls}>
        {vm.controls.canRetry ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => store.retry()}
            disabled={busy}
            leadingIcon={<RotateCcw size={16} aria-hidden="true" />}
          >
            Retry
          </Button>
        ) : null}
        {vm.controls.canCancel ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => store.cancel()}
            disabled={vm.controls.busy === "cancel"}
            leadingIcon={<X size={16} aria-hidden="true" />}
          >
            Cancel
          </Button>
        ) : null}
        {vm.controls.canReconnect ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => store.refreshHead()}
            disabled={busy}
            leadingIcon={<RotateCcw size={16} aria-hidden="true" />}
          >
            Reconnect
          </Button>
        ) : null}
        {vm.controls.canMakeCurrent && vm.makeCurrentTargetRef ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => store.makeCurrent(vm.makeCurrentTargetRef as string)}
            disabled={busy}
            leadingIcon={<GitBranch size={16} aria-hidden="true" />}
          >
            Make current
          </Button>
        ) : null}
        <span className={styles.spacer} />
        <HistoryNav store={store} vm={vm} />
      </div>

      {vm.actionError ? (
        <p className={styles.freshness} role="alert">
          {vm.actionError}
        </p>
      ) : null}

      <div className={styles.content}>
        <DossierBody
          store={store}
          body={vm.body}
          onCitationActivate={onCitationActivate}
        />
      </div>
    </div>
  );
}

function ActivityBanner({ activity }: { activity: DossierActivityView }) {
  switch (activity.kind) {
    case "Idle":
    case "Failed":
      // Failed is surfaced by the role="alert" block, not here.
      return null;
    case "Connecting":
      return (
        <div className={styles.banner} aria-hidden="true">
          <span>Connecting to generation…</span>
        </div>
      );
    case "Reconnecting":
      return (
        <div className={styles.banner} aria-hidden="true">
          <span>Reconnecting to generation…</span>
        </div>
      );
    case "Disconnected":
      return (
        <div className={styles.banner}>
          <span>Live updates are disconnected.</span>
        </div>
      );
    case "Building":
      return (
        <div className={styles.banner} aria-hidden="true">
          <span>
            {activity.regenerating
              ? "Regenerating — the current dossier stays readable."
              : "Generating the dossier…"}
          </span>
          {activity.draft ? <p className={styles.draft}>{activity.draft}</p> : null}
        </div>
      );
    case "Suspended":
      return (
        <div className={styles.banner}>
          <span>Generation stopped; it needs attention.</span>
        </div>
      );
    case "Cancelled":
      return (
        <div className={styles.banner}>
          <span>The last generation was canceled.</span>
        </div>
      );
    default: {
      const exhaustive: never = activity;
      throw new Error(`Unhandled activity: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function DossierBody({
  store,
  body,
  onCitationActivate,
}: {
  store: DossierControllerStore;
  body: DossierBodyView;
  onCitationActivate: DossierCitationActivate;
}) {
  switch (body.kind) {
    case "HeadLoading":
      return <p className={styles.empty}>Loading the dossier…</p>;
    case "HeadFailed":
      return (
        <div className={styles.empty}>
          <span>{body.message}</span>
          <Button variant="secondary" size="sm" onClick={() => store.refreshHead()}>
            Try again
          </Button>
        </div>
      );
    case "NeverGenerated":
      return (
        <p className={styles.empty}>
          No dossier yet. Generate one to synthesize this subject.
        </p>
      );
    case "HistoricalLoading":
      return <p className={styles.empty}>Loading revision…</p>;
    case "HistoricalFailed":
      return (
        <div className={styles.empty}>
          <span>{body.message}</span>
          <Button variant="secondary" size="sm" onClick={() => store.selectCurrent()}>
            View current
          </Button>
        </div>
      );
    case "StreamingDraft":
      return body.text.length > 0 ? (
        <p className={styles.draft}>{body.text}</p>
      ) : (
        <p className={styles.empty}>
          {body.liveness === "connecting"
            ? "Connecting to dossier generation…"
            : body.liveness === "reconnecting"
              ? "Reconnecting to dossier generation…"
              : body.liveness === "disconnected"
                ? "Live output is unavailable. Reconnect to check generation."
                : body.liveness === "suspended"
                  ? "Generation is suspended."
                : "Generating the dossier…"}
        </p>
      );
    case "TerminalOutcome":
      return (
        <p className={styles.empty}>
          {body.outcome === "succeeded"
            ? "Dossier generated. Loading the new revision…"
            : body.outcome === "failed"
              ? "No dossier was created by this generation."
              : "Generation was canceled before a dossier was created."}
        </p>
      );
    case "Revision":
      return (
        <div>
          {body.provenance === "historical" ? (
            <p className={styles.freshness}>Viewing a past revision.</p>
          ) : body.freshness === "Stale" ? (
            <p className={styles.freshness}>
              Sources changed since this was generated — regenerate to refresh.
            </p>
          ) : null}
          <MachineText origin={{ label: "Dossier" }}>
            <MarkdownMessage
              content={body.revision.contentMd}
              citations={body.revision.citations.map(toReaderCitationData)}
              onCitationActivate={onCitationActivate}
            />
          </MachineText>
          <div className={styles.revisionMeta} aria-label="Dossier coverage">
            <span className={styles.abstractLabel}>Coverage</span>
            <span>{dossierCoverageLabel(body.revision.inputManifest)}</span>
          </div>
          <RevisionProvenance revision={body.revision} />
          {body.revision.instruction.kind === "Present" ? (
            <div
              className={styles.revisionMeta}
              aria-label="Dossier instruction"
            >
              <span className={styles.abstractLabel}>Instruction</span>
              <span>{body.revision.instruction.value}</span>
            </div>
          ) : null}
        </div>
      );
    default: {
      const exhaustive: never = body;
      throw new Error(`Unhandled body: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function RevisionProvenance({
  revision,
}: {
  revision: Extract<DossierBodyView, { kind: "Revision" }>["revision"];
}) {
  const facts = [
    revision.creatorUserId.kind === "Present"
      ? `Creator ${revision.creatorUserId.value}`
      : "Deleted user",
    revision.modelProvider.kind === "Present"
      ? revision.modelProvider.value
      : null,
    revision.modelName.kind === "Present" ? revision.modelName.value : null,
    revision.totalTokens.kind === "Present"
      ? `${revision.totalTokens.value.toLocaleString()} tokens`
      : null,
    revision.createdAt,
  ].filter((fact): fact is string => fact !== null);
  return (
    <div className={styles.revisionMeta} aria-label="Dossier provenance">
      <span className={styles.abstractLabel}>Provenance</span>
      <span>{facts.join(" · ")}</span>
    </div>
  );
}

/** View-only revision arrows (A15): step through history; Make-current is the
 * only mutation, and it lives in the controls row above. */
function HistoryNav({
  store,
  vm,
}: {
  store: DossierControllerStore;
  vm: DossierViewModel;
}) {
  if (!vm.controls.historyAvailable) return null;
  if (vm.historyStatus === "idle" || vm.historyStatus === "loading") {
    return (
      <p className={styles.historyStatus}>Loading revision history…</p>
    );
  }
  if (vm.historyStatus === "failed") {
    return (
      <div className={styles.historyStatus} role="alert">
        <span>Revision history is unavailable.</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => store.loadHistory()}
        >
          Retry revision history
        </Button>
      </div>
    );
  }
  if (vm.history.length === 0) return null;
  const index = vm.history.findIndex(
    (entry) => entry.revisionRef === vm.selectedRevisionRef,
  );
  const go = (nextIndex: number) => {
    const entry = vm.history[nextIndex];
    if (!entry) return;
    if (entry.isCurrent) store.selectCurrent();
    else store.selectHistorical(entry.revisionRef);
  };
  return (
    <div className={styles.historyNav}>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="Older revision"
        disabled={index < 0 || index >= vm.history.length - 1}
        onClick={() => go(index + 1)}
      >
        ‹
      </Button>
      <span aria-live="off">
        {index >= 0 ? `${index + 1} / ${vm.history.length}` : `${vm.history.length} revisions`}
      </span>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="Newer revision"
        disabled={index <= 0}
        onClick={() => go(index - 1)}
      >
        ›
      </Button>
      {vm.viewingHistorical ? (
        <Button variant="ghost" size="sm" onClick={() => store.selectCurrent()}>
          Current
        </Button>
      ) : null}
    </div>
  );
}
