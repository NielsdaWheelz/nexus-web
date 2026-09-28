"use client";

// The Dossier surface (A14/A15): the sole `resource-dossier` body. It owns the
// build lifecycle UI for EVERY A15 state — never-generated, head-loading/failed,
// building, regenerating (current preserved), suspended (+Cancel), current,
// stale, failed, cancelled — driven entirely by the pure
// `deriveDossierViewModel` over the external controller store. Stream tokens
// mutate the store (this leaf re-renders per token); the pane's publication body
// stays reference-stable, so the PRIMARY pane never re-renders per token.
//
// Accessibility contract: ONE polite status region for progress/cancellation; a
// terminal build failure is a visible `role="alert"` + Retry that does NOT move
// focus; a synchronous command error sits near the control, also without moving
// focus (A14).
import { useEffect } from "react";
import { RotateCcw, X } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import MachineText from "@/components/ui/MachineText";
import { toReaderCitationData } from "@/lib/resourceGraph/citations";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import type { Schema } from "@/lib/api/wire";
import {
  useDossierSelector,
  type DossierControllerStore,
} from "@/lib/dossiers/dossierControllerStore";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import MediaAbstract from "@/components/dossier/MediaAbstract";
import {
  deriveDossierViewModel,
  type DossierActivityView,
  type DossierBodyView,
} from "@/components/dossier/dossierViewModel";
import { dossierCoverageLabel } from "@/components/dossier/dossierCoverage";
import DossierDocumentFrame, {
  type DossierDocumentFindCapability,
} from "@/components/dossier/DossierDocumentFrame";
import styles from "./DossierSurface.module.css";

export type DossierCitationActivate = (
  activation: ResourceActivation,
  target: ReaderSourceTarget | null,
  disposition: { readonly kind: "Follow" | "Fork" },
) => void;

interface DossierSurfaceProps {
  store: DossierControllerStore;
  onViewMediaEvidence: () => void;
  /** Wired by the pane/controller to route citation clicks through the pane
   * router; defaults to reader-source dispatch for in-document targets. */
  onCitationActivate?: DossierCitationActivate;
  /** Relays the exact rendered revision's frame-owned Find capability. */
  onFindCapabilityChange?: (
    capability: DossierDocumentFindCapability | null,
  ) => void;
  /** Relays a validated iframe Cmd/Ctrl+F request to the pane owner. */
  onFindRequested?: () => void;
}

const defaultCitationActivate: DossierCitationActivate = (
  _activation,
  target,
  _disposition,
) => {
  if (target) dispatchReaderSourceActivation(target);
};

const ignoreFindCapability = (
  _capability: DossierDocumentFindCapability | null,
) => {};
const ignoreFindRequest = () => {};

export default function DossierSurface({
  store,
  onViewMediaEvidence,
  onCitationActivate = defaultCitationActivate,
  onFindCapabilityChange = ignoreFindCapability,
  onFindRequested = ignoreFindRequest,
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
  const documentTitle = useDossierSelector(store, (state) => {
    if (state.head.kind !== "Ready") return "Dossier";
    const identity = state.head.ready.identity;
    return identity.kind === "Present" ? identity.value.title : "Dossier";
  });
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
    <div className={styles.surface}>
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
      <GenerationDetail detail={vm.generationDetail} />

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
          documentTitle={documentTitle}
          onCitationActivate={onCitationActivate}
          onFindCapabilityChange={onFindCapabilityChange}
          onFindRequested={onFindRequested}
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
        </div>
      );
    case "Suspended":
      return (
        <div className={styles.banner}>
          <span>Generation stopped; it needs attention.</span>
        </div>
      );
    case "CapacityPaused":
      return <CapacityPausedBanner pause={activity.pause} />;
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

/** Spec 3.4: a quota-parked admission waits durably (no spend, no model switch);
 * the Cancel control in the controls row stays available. */
function CapacityPausedBanner({ pause }: { pause: Schema<"CapacityPaused"> }) {
  const environment = useRenderEnvironment();
  const formatInstant = (instant: string): string => {
    const formatted = formatDisplayDate(instant, environment, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    if (formatted === null) {
      throw new Error(`Capacity pause instant is not a valid instant: ${instant}`);
    }
    return formatted;
  };
  return (
    <div className={styles.banner}>
      <span>Waiting for Codex capacity</span>
      <span>
        {pause.reset_at.kind === "Present"
          ? `Codex reports capacity returning at ${formatInstant(pause.reset_at.value)}.`
          : `Nexus checks again at ${formatInstant(pause.next_check_at)}.`}
      </span>
    </div>
  );
}

function toolPlanFact(
  plan: Schema<"DossierBuildAdmittedGenerationOut">["tool_plan"],
  toolPositions: number,
): string {
  switch (plan.kind) {
    case "NoModelTools":
      return "No model tools";
    case "CodexShell": {
      const calls = `${toolPositions} api ${toolPositions === 1 ? "call" : "calls"}`;
      return `Account-wide reading and additive writes · ${calls}`;
    }
    case "ExactModelTools": {
      const mode = plan.effect_mode === "ReadOnly" ? "read-only" : "additive writes";
      const calls = `${toolPositions} tool ${toolPositions === 1 ? "call" : "calls"}`;
      return `${plan.plan_id} (${mode}) · ${calls}`;
    }
    default: {
      const exhaustive: never = plan;
      throw new Error(`Unhandled tool plan: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** AC 15: the admitted selection, disclosure, tool plan, and tool activity of
 * the build the activity concerns — semantic text only, never a control. */
function GenerationDetail({
  detail,
}: {
  detail: Schema<"DossierBuildAdmittedGenerationOut"> | null;
}) {
  if (detail === null) return null;
  const { display_at_dispatch: display, tool_plan, tool_positions } = detail;
  const facts = [
    display.route_label,
    display.model_label,
    `thinking: ${display.reasoning_label}`,
    display.billing.label,
    toolPlanFact(tool_plan, tool_positions),
  ];
  return (
    <div
      className={styles.revisionMeta}
      role="note"
      aria-label="Generation detail"
    >
      <span className={styles.abstractLabel}>Generation</span>
      <span>{facts.join(" · ")}</span>
    </div>
  );
}

function DossierBody({
  store,
  body,
  documentTitle,
  onCitationActivate,
  onFindCapabilityChange,
  onFindRequested,
}: {
  store: DossierControllerStore;
  body: DossierBodyView;
  documentTitle: string;
  onCitationActivate: DossierCitationActivate;
  onFindCapabilityChange: (
    capability: DossierDocumentFindCapability | null,
  ) => void;
  onFindRequested: () => void;
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
    case "Building":
      return (
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
        <div className={styles.revision}>
          {body.stale ? (
            <p className={styles.freshness}>
              Sources changed since this was generated — regenerate to refresh.
            </p>
          ) : null}
          <MachineText origin={{ label: "Dossier" }}>
            <DossierDocumentFrame
              title={documentTitle}
              revisionRef={body.revision.revision_ref}
              contentHtml={body.revision.content_html}
              onFindCapabilityChange={onFindCapabilityChange}
              onFindRequested={onFindRequested}
              onCitation={(ordinal, disposition) => {
                const citation = body.revision.citations.find(
                  (entry) => entry.ordinal === ordinal,
                );
                if (!citation) return;
                const data = toReaderCitationData(citation);
                onCitationActivate(
                  data.activation,
                  data.target,
                  disposition,
                );
              }}
            />
          </MachineText>
          <div className={styles.revisionMeta} aria-label="Dossier coverage">
            <span className={styles.abstractLabel}>Coverage</span>
            <span>{dossierCoverageLabel(body.revision.input_manifest)}</span>
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
  revision: Schema<"DossierRevisionOut">;
}) {
  const facts = [
    revision.creator_user_id.kind === "Present"
      ? `Creator ${revision.creator_user_id.value}`
      : "Deleted user",
    revision.model_provider.kind === "Present"
      ? revision.model_provider.value
      : null,
    revision.model_name.kind === "Present" ? revision.model_name.value : null,
    revision.total_tokens.kind === "Present"
      ? `${revision.total_tokens.value.toLocaleString()} tokens`
      : null,
    revision.created_at,
  ].filter((fact): fact is string => fact !== null);
  return (
    <div className={styles.revisionMeta} aria-label="Dossier provenance">
      <span className={styles.abstractLabel}>Provenance</span>
      <span>{facts.join(" · ")}</span>
    </div>
  );
}
