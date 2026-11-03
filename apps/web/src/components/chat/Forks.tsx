"use client";

import { memo, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import * as Icon from "@/lib/ui/icons";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import { Announcement, Hold, useResendFeedback, useOutcome } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { MarkdownPreview, TextPreview } from "@/components/ui/MarkdownMessage";
import { admissionReason, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { sayRefusal, type CommandOutcome } from "@/lib/chat/commands";
import { anchorQuote, outline, type Alternative, type Children } from "@/lib/chat/tree";
import { conversationViewHref } from "@/lib/chat/view";
import type { ChatFailure, Message } from "@/lib/chat/wire";
import { truncateText } from "@/lib/display/format";
import { requirePaneRuntime, usePaneParam, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useChatPane } from "./ChatSurface";
import styles from "./ChatPanels.module.css";

/**
 * A stable split-point control. Each choice is a link to that branch's view: a plain
 * activation shows it in this pane, shift opens a new pane; nothing is written.
 */
function branchHref(conversationId: string, leafId: string, userId: string): string {
  return `${conversationViewHref(conversationId, leafId)}&message=${userId}`;
}

export const AlternativeSelector = memo(function AlternativeSelector({ options }: {
  options: readonly Alternative[];
}) {
  const { region } = useChatPane();
  const runtime = requirePaneRuntime(usePaneRuntime(), "AlternativeSelector");
  const conversationId = usePaneParam("id");
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const skipReturn = useRef(false);
  if (!options.length || !conversationId) return null;
  // no current choice: the pane's path ends here, and these are its continuations
  const index = options.findIndex((option) => option.current);
  const activate = (event: TargetActivationEvent, option: Alternative) => {
    const result = activateTargetLink({
      event,
      runtime,
      target: { href: branchHref(conversationId, option.leafId, option.user.id) },
    });
    if (result !== "handled-default" && result !== "handled-new-pane") return;
    skipReturn.current = true;
    setOpen(false);
  };
  return (
    <>
      <Button
        icon={<Icon.Forks />}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={index < 0 ? `continuations, ${options.length}` : `alternatives, ${index + 1} of ${options.length}`}
        onClick={(event) => {
          opener.current = event.currentTarget;
          skipReturn.current = false;
          setOpen(true);
        }}
      >
        {index < 0 ? "continuations" : `${index + 1} / ${options.length}`}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={index < 0 ? "continuations" : "alternatives"}
        initialFocus={(panel) => panel.querySelector<HTMLElement>('[aria-current="true"], a')}
        returnFocusTo={() => (opener.current?.isConnected ? { element: opener.current, preventScroll: true } : null)}
        returnFocusFallback={() => (region.current ? { element: region.current, preventScroll: true } : null)}
        skipReturnFocus={() => skipReturn.current}
      >
        <div className={styles.alternatives}>
          {options.map((option, ordinal) => {
            const ran = option.answer?.trust_trail!.run.run_selection; // an answer's trail always carries its run
            return (
              <a
                key={option.user.id}
                className={styles.alternative}
                href={branchHref(conversationId, option.leafId, option.user.id)}
                data-workspace-rich-target="true"
                aria-current={option.current || undefined}
                onClick={(event) => activate(event, option)}
                onKeyDown={(event) => activate(event, option)}
              >
                <span className={styles.alternativeHead}>
                  <strong>{option.user.fork_title || `alternative ${ordinal + 1}`}</strong>
                  {option.current ? <span className={styles.badge}>current</span> : null}
                </span>
                <AlternativePreview alternative={option} />
                <span className={styles.faint}>
                  {ran
                    ? `${[ran.display_at_dispatch.route_label, ran.display_at_dispatch.model_label, ran.display_at_dispatch.reasoning_label].join(" · ")} · `
                    : ""}
                  {responseState(option.answer)}
                </span>
              </a>
            );
          })}
        </div>
      </Dialog>
    </>
  );
});

function responseState(answer: Message | null): string {
  if (!answer) return "no answer";
  if (answer.trust_trail!.run.failure?.code === "invalid_output") return "unreadable answer";
  return { pending: "answering", complete: "complete", error: "unfinished", cancelled: "stopped" }[answer.status];
}

function AlternativePreview({ alternative: { user, answer } }: { alternative: Alternative }) {
  if (!answer) return <span>prompt: <TextPreview content={user.content} /></span>;
  if (answer.trust_trail!.run.failure?.code === "invalid_output") return <span>answer not shown: malformed reply</span>;
  if (answer.status === "pending") return null;
  if (!answer.content.trim()) return <span>no saved text</span>;
  return (
    <span>
      {answer.status === "error" || answer.status === "cancelled" ? <span className={styles.faint}>partial answer</span> : null}
      <MarkdownPreview content={answer.content} />
    </span>
  );
}

const UNRENAMED = "couldn’t rename this fork.";

/** The inspector's Forks tab: every user turn as an outline to search, open, rename, delete. A
 * rename whose answer never came is held until one answers; renaming to the same title succeeds,
 * so its retry resends the frozen request. */
export function ForksPanel({ tree, pathIds, onRename, onDelete }: {
  tree: Children;
  pathIds: ReadonlySet<string>;
  onRename(userId: string, title: string | null, expectedTitle: string | null): Promise<ChatFailure | { kind: "Missing" } | null>;
  onDelete(userId: string): Promise<CommandOutcome>;
}) {
  const slips = useOutcome();
  const { say, fail } = slips;
  // a refused deletion's retry deletes again, through the same confirmation
  const remove = (id: string) => void onDelete(id)
    .then((outcome) => sayRefusal(slips, outcome, { label: "retry", commandKey: `delete fork ${id}`, run: () => remove(id) }));
  const runtime = requirePaneRuntime(usePaneRuntime(), "ForksPanel");
  const conversationId = usePaneParam("id");
  const rows = useMemo(() => outline(tree, pathIds), [tree, pathIds]);
  const [query, setQuery] = useState("");
  const edit = useResourceDraft<{
    id: string; title: string; baseline: string | null; pending: boolean;
    request: { title: string | null; expectedTitle: string | null } | null;
    /** Attempts of `request` whose answer never came. */
    unknown: number;
  } | null>(`Chat.ForkTitle:${conversationId}`, () => null,
    value => ({ changed: value !== null && value.title !== (value.baseline ?? ""), unconfirmed: value !== null && value.request !== null, stopsBrowserWork: false }));
  const editing = edit.value;
  const waitsId = useId();
  const resendFeedback = useResendFeedback();
  const guard = useWorkGuard();
  const dismiss = () => { if (guard.confirmLoss({ scopes: [], ownerIds: [edit.owner] })) edit.set(null); };
  const rename = async () => {
    const current = edit.read();
    if (!current || current.pending || (current.unknown > 0 && renameWaits)) return;
    const request = current.request ?? { title: current.title.trim() || null, expectedTitle: current.baseline };
    edit.set({ ...current, request, pending: true });
    const failure = await onRename(current.id, request.title, request.expectedTitle);
    if (failure?.kind === "Defect") return void fail(failure.error, UNRENAMED);
    edit.set(value => {
      if (!value || value.id !== current.id || value.request !== request) return value;
      if (failure === null) return value.title === current.title ? null : { ...value, baseline: request.title, request: null, pending: false, unknown: 0 };
      return failure.kind === "Unknown" || ((failure.kind === "Refused" || failure.kind === "Handled") && value.unknown > 0) ? { ...value, pending: false, unknown: value.unknown + 1 } : { ...value, request: null, pending: false, unknown: 0 };
    });
    if (failure === null || failure.kind === "Unknown" || failure.kind === "Handled" || current.unknown > 0) return;
    if (failure.kind === "Missing") return void say({ fact: UNRENAMED, reason: "it doesn’t exist." });
    if (failure.kind === "Refused" && failure.error.code === "E_RESOURCE_CONFLICT") return void say({ fact: UNRENAMED });
    if (failure.kind === "Refused" && failure.error.code === "E_MESSAGE_NOT_FOUND") return void say({ fact: UNRENAMED, reason: "it doesn’t exist." });
    fail(failure.error, UNRENAMED, { label: "retry", commandKey: `rename ${current.id}`, run: () => void rename() });
  };
  const renameKey = editing ? `rename ${editing.id}` : "";
  const recovery = editing?.request && editing.unknown > 0 ? resendFeedback({
    line: { fact: "not sure the fork was renamed.", reason: UNKNOWN_OUTCOME_REASON },
    resend: { label: "retry", commandKey: renameKey, busy: editing.pending, run: () => void rename() },
  }) : null;
  const primary = recovery?.verbs?.[0];
  const replay = primary && "commandKey" in primary && primary.commandKey === renameKey ? primary : null;
  const renameWaits = recovery !== null && (replay === null || replay.busy || replay.disabledReason !== undefined);
  const waitReason = replay?.disabledReason ?? admissionReason() ?? recovery?.line.reason;
  const needle = query.trim().toLowerCase();
  const activate = (event: TargetActivationEvent, leafId: string, userId: string) => {
    if (!conversationId) return;
    activateTargetLink({ event, runtime, target: { href: branchHref(conversationId, leafId, userId) } });
  };
  const visible = rows.filter(({ user, answer }) =>
    [user.content, user.fork_title, anchorQuote(user), answer?.content].some((text) => text?.toLowerCase().includes(needle)),
  );
  // the count speaks when the query changes, never when the tree does
  const [searched, setSearched] = useState({ needle, occurrence: {} });
  if (searched.needle !== needle) setSearched({ needle, occurrence: {} });
  const found = `${visible.length} ${visible.length === 1 ? "fork" : "forks"} found`;
  return (
    <div className={styles.panel}>
      {editing && recovery ? <Hold id={`rename:${editing.id}`} attempt={editing.unknown} {...recovery} /> : null}
      {renameWaits ? <span id={waitsId} className="sr-only">{waitReason}</span> : null}
      <label className={styles.search}>
        <Icon.Search size={14} aria-hidden="true" />
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search forks" placeholder="Search forks" />
      </label>
      <p className={styles.faint}>{found}</p>
      <Announcement text={found} level={needle ? "Polite" : "None"} occurrence={searched.occurrence} />
      <ul className={styles.outline} aria-label="Conversation forks">
        {visible.map((row) => {
          const id = row.user.id;
          const title = row.user.fork_title || truncateText(row.user.content, 90);
          const quote = anchorQuote(row.user);
          return (
            <li key={id} data-active={row.current} style={{ "--depth": row.depth } as CSSProperties}>
              {editing?.id === id ? (
                <form
                  className={styles.actions}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void rename();
                  }}
                >
                  <input
                    autoFocus
                    value={editing.title}
                    maxLength={120}
                    onChange={(event) => edit.set({ ...editing, title: event.target.value })}
                    aria-label={`Rename fork ${title}`}
                  />
                  <Button emphasis="strong" type="submit" disabled={editing.pending || renameWaits} aria-busy={editing.pending || replay?.busy} aria-describedby={renameWaits ? waitsId : undefined} aria-label={`Save fork ${title}`}>{editing.request ? "retry" : "Save"}</Button>
                  <Button onClick={dismiss}>Cancel</Button>
                </form>
              ) : (
                <>
                  <a
                    href={conversationId ? branchHref(conversationId, row.leafId, id) : undefined}
                    data-workspace-rich-target="true"
                    className={styles.outlineTitle}
                    aria-label={`Open fork ${title}`}
                    onClick={(event) => activate(event, row.leafId, id)}
                    onKeyDown={(event) => activate(event, row.leafId, id)}
                  >
                    {title}
                    {row.current ? <span className={styles.badge}>current</span> : null}
                  </a>
                  {quote ? <blockquote>{truncateText(quote, 120)}</blockquote> : null}
                  <span className={styles.actions}>
                    <span className={styles.faint}>{responseState(row.answer)}</span>
                    <Button aria-label={`Rename fork ${title}`} onClick={() => { if (guard.confirmLoss({ scopes: [], ownerIds: [edit.owner] })) edit.set({ id, title: row.user.fork_title ?? "", baseline: row.user.fork_title, pending: false, request: null, unknown: 0 }); }}>
                      Rename
                    </Button>
                    <Button tone="danger" aria-label={`Delete fork ${title}`} onClick={() => remove(id)}>
                      Delete
                    </Button>
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
