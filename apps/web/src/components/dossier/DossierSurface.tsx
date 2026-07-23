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
import styles from "./DossierSurface.module.css";

export type DossierCitationActivate = (
  activation: ResourceActivation,
  target: ReaderSourceTarget | null,
  event?: React.MouseEvent,
) => void;

interface DossierSurfaceProps {
  store: DossierControllerStore;
  /** Wired by the pane/controller to route citation clicks through the pane
   * router; defaults to reader-source dispatch for in-document targets. */
  onCitationActivate?: DossierCitationActivate;
}

const defaultCitationActivate: DossierCitationActivate = (_activation, target) => {
  if (target) dispatchReaderSourceActivation(target);
};

export default function DossierSurface({
  store,
  onCitationActivate = defaultCitationActivate,
}: DossierSurfaceProps) {
  // A14: connect on mount / disconnect the CLIENT stream on unmount — the
  // durable build continues; remount refetches the head and resumes.
  useEffect(() => {
    store.attach();
    return () => store.detach();
  }, [store]);

  const vm = useDossierSelector(store, deriveDossierViewModel);
  const busy = vm.controls.busy !== null;

  return (
    <div className={styles.surface} data-testid="resource-dossier-surface">
      <div className={styles.statusRegion} role="status" aria-live="polite">
        {vm.statusMessage}
      </div>

      {vm.mediaAbstract ? <MediaAbstract abstract={vm.mediaAbstract} /> : null}

      <ActivityBanner activity={vm.activity} />

      {vm.alert ? (
        <div className={`${styles.banner} ${styles.bannerAlert}`} role="alert">
          <span>{vm.alert.message}</span>
          {vm.alert.retry ? (
            <div className={styles.bannerRow}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => store.retry()}
                disabled={busy}
                leadingIcon={<RotateCcw size={16} aria-hidden="true" />}
              >
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={styles.controls}>
        {vm.controls.canGenerate ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => store.generate(null)}
            disabled={busy}
          >
            Generate dossier
          </Button>
        ) : null}
        {vm.controls.canRegenerate ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => store.regenerate(null)}
            disabled={busy}
            leadingIcon={<RotateCcw size={16} aria-hidden="true" />}
          >
            Regenerate
          </Button>
        ) : null}
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
        <p className={styles.freshness} role="status">
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
        <p className={styles.empty}>Generating the dossier…</p>
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
        </div>
      );
    default: {
      const exhaustive: never = body;
      throw new Error(`Unhandled body: ${JSON.stringify(exhaustive)}`);
    }
  }
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
  if (!vm.controls.historyAvailable || vm.history.length === 0) return null;
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
