"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import {
  FeedbackNotice,
  type FeedbackActions,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ContextEdgeMenu from "@/components/resources/ContextEdgeMenu";
import LinkTargetDialog from "@/components/resources/LinkTargetDialog";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import MachineText from "@/components/ui/MachineText";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import {
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import {
  queryConnections,
  type ConnectionOut,
  type EdgeKind,
} from "@/lib/resourceGraph/connections";
import {
  createLink,
  deleteLink,
  type LinkTarget,
} from "@/lib/resourceGraph/links";
import {
  formatResourceRef,
  type ResourceRef,
} from "@/lib/resourceGraph/resourceRef";
import { deleteStance, putStance } from "@/lib/resourceGraph/stances";
import { hrefForResourceActivation } from "@/lib/resources/activation";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import {
  dismissSynapseEdge,
  fetchSynapseScanStatus,
  requestSynapseScan,
  type SynapseScanStatus,
} from "@/lib/synapse";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import styles from "./ConnectionsSurface.module.css";

type ScanPhase = "idle" | "scanning" | "settled" | "failed" | "overdue";

const ORIGINS = [
  "user",
  "note_body",
  "highlight_note",
  "citation",
  "synapse",
  "document_embed",
] as const;
const ERROR_COPY: Record<string, string> = {
  E_NOT_FOUND:
    "The connection or one of its objects is gone. Reload Connections.",
  E_FORBIDDEN: "This account can’t make that change.",
  E_INVALID_REQUEST: "That request is no longer valid. Review it and retry.",
  E_LINK_SELF: "An item can’t link to itself. Choose another target.",
  E_LINK_CAPABILITY: "This source or target doesn’t support links.",
  E_LINK_TARGET_AMBIGUOUS:
    "That passage matches more than once. Choose a narrower one.",
  E_LINK_TARGET_STALE: "That passage changed. Search for it again, then retry.",
  E_HIGHLIGHT_CONFLICT:
    "The selected passage changed. Select it again, then retry.",
};

/** Expected failures become copy; anything else is a defect and throws. */
function failure(error: unknown, title: string): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const message = ERROR_COPY[error.code];
  const content =
    apiTransportFeedback(error, title) ??
    (message && {
      tone: "Danger" as const,
      title,
      message,
      requestId: error.requestId,
    });
  if (!content) throw error;
  return content;
}

/** Every page, human assertions first, then synapse; newest first in each. */
async function loadConnections(ref: string, signal: AbortSignal) {
  const items: ConnectionOut[] = [];
  let cursor: string | undefined;
  do {
    const page = await queryConnections(
      {
        refs: [ref],
        direction: "both",
        rollup: "owner",
        filters: { origins: [...ORIGINS] },
        limit: 100,
        cursor,
      },
      { signal },
    );
    items.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return items.sort(
    (a, b) =>
      Number(a.origin === "synapse") - Number(b.origin === "synapse") ||
      b.created_at.localeCompare(a.created_at),
  );
}

export default function ConnectionsSurface({
  resourceRef,
}: {
  resourceRef: ResourceRef;
}) {
  const selfRef = formatResourceRef(resourceRef);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((value) => value + 1);
  const list = useResource<ConnectionOut[]>({
    cacheKey: `connections:${selfRef}:${tick}`,
    load: (signal) => loadConnections(selfRef, signal),
  });
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  // A pick's failure stays in the open dialog, with the exact retry.
  const [notice, setNotice] = useState<{
    content: FeedbackContent;
    actions: FeedbackActions;
  } | null>(null);
  // The menu item that opened the dialog is gone by close: focus returns to ＋.
  const [linking, setLinking] = useState<{
    kind: EdgeKind;
    trigger: HTMLElement | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const linkIdentity = useRef<{ key: string; id: string } | null>(null);
  const scannable =
    resourceRef.scheme === "note_block" || resourceRef.scheme === "page";
  const scan = useSynapseScan(selfRef, scannable, reload);
  if (defect) throw defect.error;
  if (scan.defect) throw scan.defect;

  /** A stance needs a whole item; a retried Link replays its mutation id. */
  async function pick(kind: EdgeKind, target: LinkTarget) {
    if (kind !== "context" && target.kind === "passage") {
      setNotice({
        content: {
          tone: "Warning",
          title: "A stance needs a whole item, not a passage.",
        },
        actions: [{ label: "Choose again", onClick: () => setNotice(null) }],
      });
      return;
    }
    const key = JSON.stringify(target);
    if (linkIdentity.current?.key !== key)
      linkIdentity.current = { key, id: createRandomId("link") };
    const clientMutationId = linkIdentity.current.id;
    setBusy(true);
    setNotice(null);
    try {
      if (kind === "context" || target.kind === "passage") {
        await createLink({
          clientMutationId,
          source: { kind: "resource", ref: selfRef },
          target,
        });
      } else {
        await putStance({ sourceRef: selfRef, targetRef: target.ref, kind });
      }
      linkIdentity.current = null;
      setLinking(null);
      reload();
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      try {
        setNotice({
          content: failure(
            error,
            kind === "context"
              ? "Link wasn’t created"
              : "Stance wasn’t recorded",
          ),
          actions: [{ label: "Retry", onClick: () => void pick(kind, target) }],
        });
      } catch (caught) {
        setDefect({ error: caught });
      }
    } finally {
      setBusy(false);
    }
  }

  const connections = list.status === "ready" ? list.data : [];
  const proposed = connections.filter(
    (c) => c.origin === "synapse" && c.source_ref === selfRef,
  ).length;
  const voice = {
    idle: null,
    scanning: "Scanning…",
    settled:
      list.status !== "ready"
        ? null
        : proposed > 0
          ? `${proposed} proposed connection${proposed === 1 ? "" : "s"}.`
          : "No connections proposed.",
    failed: "The scan failed. Try again later.",
    overdue: "Still scanning. Proposals appear here when it finishes.",
  }[scan.phase];

  return (
    <section className={styles.section} aria-label="Connections">
      <div className={styles.header}>
        <h2 className={styles.title}>Connections</h2>
        <ActionMenu
          label="Add connection"
          triggerDisabled={busy}
          renderTrigger={(props) => (
            <button {...props} className={styles.add}>
              <Plus size={14} aria-hidden="true" /> Link
            </button>
          )}
          options={(["context", "supports", "contradicts"] as const).map(
            (kind) => ({
              kind: "command",
              id: kind,
              label: kind === "context" ? "Link…" : `Record “${kind}”…`,
              restoreFocusOnClose: false,
              onSelect: ({ triggerEl }) =>
                setLinking({ kind, trigger: triggerEl }),
            }),
          )}
        />
        {scannable ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            loading={scan.phase === "scanning"}
            aria-label="Find connections"
            title="Find connections"
            onClick={() => void scan.start()}
          >
            <Sparkles size={14} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {scan.feedback ? (
        <FeedbackNotice
          content={scan.feedback}
          announcement="Assertive"
          actions={[{ label: "Retry", onClick: () => void scan.start() }]}
        />
      ) : null}
      {voice ? (
        <p className={styles.voice} role="status">
          {voice}
        </p>
      ) : null}
      {list.status === "error" ? (
        <FeedbackNotice
          content={failure(list.error, "Connections couldn’t be loaded")}
          announcement="Assertive"
          actions={[{ label: "Retry", onClick: list.retry }]}
        />
      ) : list.status !== "ready" ? (
        <FeedbackNotice
          content={{ tone: "Info", title: "Loading connections…" }}
          announcement="Polite"
        />
      ) : connections.length === 0 ? (
        <p className={styles.empty}>
          {scannable
            ? "No connections yet. Scan to find resonant material, or link one."
            : "No connected objects yet."}
        </p>
      ) : (
        <ResourceList ariaLabel="Connections">
          {connections.map((connection) => (
            <Row
              key={connection.edge_id}
              connection={connection}
              onChanged={reload}
            />
          ))}
        </ResourceList>
      )}
      <LinkTargetDialog
        open={linking !== null}
        sourceRef={selfRef}
        busy={busy}
        failure={notice}
        returnFocusTo={() => linking?.trigger ?? null}
        onPick={(target) => linking && void pick(linking.kind, target)}
        onClose={() => {
          setLinking(null);
          setNotice(null);
        }}
      />
    </section>
  );
}

function Row({
  connection,
  onChanged,
}: {
  connection: ConnectionOut;
  onChanged: () => void;
}) {
  const far = connection.other;
  const label = far.label ?? far.ref;
  const href = far.missing ? null : hrefForResourceActivation(far.activation);
  const Icon = resourceIconForUri(far.ref);
  const synapse = connection.origin === "synapse";
  const rationale = synapse ? connection.snapshot?.excerpt : undefined;
  // Edge commands own their control: a user edge unlinks (Link or stance), a
  // synapse proposal dismisses. Other origins are derived and read-only.
  const edge =
    connection.origin === "user"
      ? {
          action: "Unlink" as const,
          title: "Connection wasn’t unlinked",
          run: () =>
            connection.kind === "context"
              ? deleteLink(connection.edge_id)
              : deleteStance(connection.edge_id),
        }
      : synapse
        ? {
            action: "Dismiss" as const,
            title: "Proposal wasn’t dismissed",
            run: () => dismissSynapseEdge(connection.edge_id),
          }
        : null;

  return (
    <ResourceRow
      primary={
        href === null
          ? { kind: "static" }
          : {
              kind: "link",
              href,
              paneLabelHint: label,
              ...(far.activation.kind === "external"
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {}),
            }
      }
      title={
        <>
          <Icon size={14} aria-hidden="true" /> {label}
        </>
      }
      supporting={synapse ? `✦ proposed · ${connection.kind}` : connection.kind}
      evidence={
        typeof rationale === "string" ? (
          <MachineText variant="inline" as="span" origin={{ label: "Synapse" }}>
            {rationale}
          </MachineText>
        ) : undefined
      }
      actions={
        <>
          <ResourceActionMenu
            actionSubject={far.actionSubject}
            label={`Actions for ${label}`}
          />
          {edge ? (
            <ContextEdgeMenu
              action={edge.action}
              label={`Edit connection ${label}`}
              retryable
              execute={async () => {
                await edge.run();
                onChanged();
              }}
              presentFailure={(error) => failure(error, edge.title)}
            />
          ) : null}
        </>
      }
    />
  );
}

/**
 * Manual scan: request, then poll the job-backed status every 2 s until it
 * leaves pending/running or 45 s pass. A scan already in flight when the
 * section mounts (a tab switch mid-scan) resumes the wait.
 */
function useSynapseScan(ref: string, enabled: boolean, onSettled: () => void) {
  const [phase, setPhase] = useState<ScanPhase>("idle");
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<unknown>(null);
  const deadline = useRef(0);
  const inFlight = (status: SynapseScanStatus) =>
    status === "pending" || status === "running";

  function observe(status: SynapseScanStatus) {
    if (inFlight(status))
      return setPhase(Date.now() < deadline.current ? "scanning" : "overdue");
    setPhase(status === "failed" ? "failed" : "settled");
    onSettled();
  }

  function fail(error: unknown, title: string) {
    setPhase("idle");
    if (handleUnauthenticatedApiError(error)) return;
    try {
      setFeedback(failure(error, title));
    } catch (caught) {
      setDefect(caught);
    }
  }

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // Best effort: a failed probe is not the user's action.
    fetchSynapseScanStatus(ref).then(
      (status) => {
        if (!live || !inFlight(status)) return;
        deadline.current = Date.now() + 45_000;
        setPhase("scanning");
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [enabled, ref]);

  // justify-polling: scans run on the background worker with no event plane;
  // the poll is user-started, every 2 s, and ends at the 45 s deadline.
  useIntervalPoll({
    enabled: phase === "scanning",
    pollIntervalMs: 2000,
    onPoll: () =>
      fetchSynapseScanStatus(ref).then(observe, (error) =>
        fail(error, "Scan status couldn’t be checked"),
      ),
  });

  async function start() {
    setFeedback(null);
    deadline.current = Date.now() + 45_000;
    setPhase("scanning");
    try {
      observe(await requestSynapseScan(ref));
    } catch (error) {
      fail(error, "Scan wasn’t started");
    }
  }

  return { phase, feedback, defect, start };
}
