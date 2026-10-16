"use client";

import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { GitBranch, Search } from "lucide-react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { MarkdownPreview, TextPreview } from "@/components/ui/MarkdownMessage";
import type { CommandOutcome, CommandState } from "@/lib/chat/commands";
import {
  anchorQuote,
  outline,
  type Alternative,
  type Children,
} from "@/lib/chat/tree";
import type { Message } from "@/lib/chat/wire";
import { truncateText } from "@/lib/display/format";
import footerStyles from "./MessageFooter.module.css";
import styles from "./ChatPanels.module.css";

const titleOf = ({ user }: Alternative, length: number) =>
  user.fork_title || truncateText(user.content, length);

/** A stable split-point control. Choosing a branch never edits the saved tree. */
export const AlternativeSelector = memo(function AlternativeSelector({
  options,
  parentId,
  command,
  onOpen,
  onRootSelected,
  region,
  retryCommand,
  refreshCommand,
}: {
  options: readonly Alternative[];
  parentId: string | null;
  command: CommandState;
  onOpen(leafId: string, anchorId: string | null): Promise<CommandOutcome>;
  onRootSelected(userId: string): void;
  region: RefObject<HTMLDivElement | null>;
  retryCommand(): Promise<CommandOutcome>;
  refreshCommand(): Promise<CommandOutcome>;
}) {
  const [opening, setOpening] = useState<{ opener: HTMLButtonElement } | null>(null);
  const currentOpening = useRef(opening);
  const opener = useRef<HTMLButtonElement | null>(null);
  const attempted = useRef<{ leafId: string; userId: string } | null>(null);
  const skipReturn = useRef(false);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  useEffect(() => () => { currentOpening.current = null; }, []);
  const close = () => { currentOpening.current = null; attempted.current = null; setOpening(null); };
  if (options.length < 2) return null;
  const index = options.findIndex((option) => option.current);
  if (index < 0) throw new Error("Alternatives require a current child");
  const selection = command.kind !== "Idle" && command.command.kind === "SelectLeaf" ? command.command : null;
  const pending = command.kind !== "Idle" && selection && (
    attempted.current?.leafId === selection.leafId || options.some((option) => option.leafId === selection.leafId)
  ) ? command : null;
  const shownFailure = pending?.feedback ?? failure;
  const finish = (outcome: CommandOutcome, userId: string, request: typeof opening, closeOnSettled: boolean) => {
    if (!request || request !== currentOpening.current) return;
    if (outcome.kind === "Settled" && closeOnSettled) {
      skipReturn.current = parentId === null;
      close();
      if (parentId === null) onRootSelected(userId);
    } else if ("feedback" in outcome) setFailure(outcome.feedback);
    else setFailure(null);
  };
  const choose = async (option: Alternative) => {
    if (option.current) return close();
    const request = currentOpening.current;
    attempted.current = { leafId: option.leafId, userId: option.user.id };
    const outcome = await onOpen(option.leafId, parentId);
    finish(outcome, option.user.id, request, true);
  };
  const recover = async (retry: boolean) => {
    if (!pending || pending.command.kind !== "SelectLeaf") return;
    const leafId = pending.command.leafId;
    const userId = attempted.current?.leafId === leafId ? attempted.current.userId
      : options.find((candidate) => candidate.leafId === leafId)?.user.id ?? null;
    if (userId === null) return;
    const request = currentOpening.current;
    const outcome = await (retry ? retryCommand() : refreshCommand());
    finish(outcome, userId, request, retry || pending.kind === "Reconciling");
  };
  return (
    <>
      <button type="button" className={footerStyles.control} aria-haspopup="dialog"
        aria-expanded={opening !== null} aria-label={`alternatives, ${index + 1} of ${options.length}`}
        onClick={(event) => {
          const request = { opener: event.currentTarget };
          opener.current = event.currentTarget;
          attempted.current = null;
          currentOpening.current = request; skipReturn.current = false;
          setFailure(null); setOpening(request);
        }}><GitBranch size={16} aria-hidden="true" />{index + 1} / {options.length}</button>
      <Dialog open={opening !== null} onClose={close} title="alternatives"
        initialFocus={(panel) => panel.querySelector<HTMLElement>('[aria-current="true"]')}
        returnFocusTo={() => opener.current?.isConnected ? { element: opener.current, preventScroll: true } : null}
        returnFocusFallback={() => region.current ? { element: region.current, preventScroll: true } : null}
        skipReturnFocus={() => skipReturn.current}>
        <div className={styles.alternatives}>
          {shownFailure ? <FeedbackNotice announcement="Polite" content={shownFailure} /> : null}
          {pending && (pending.kind === "Sending" || pending.kind === "Reconciling") ? <p role="status">opening alternative…</p> : null}
          {pending?.kind === "Unconfirmed" ? <Button variant="secondary" size="sm" className={footerStyles.dialogControl} onClick={() => void recover(true)}>retry original change</Button>
            : pending && (pending.kind === "RefreshRequired" || (pending.kind === "Reconciling" && pending.feedback)) ? <Button variant="secondary" size="sm" className={footerStyles.dialogControl} onClick={() => void recover(false)}>retry refresh</Button> : null}
          {options.map((option, ordinal) => {
            const shown = option.answer?.trust_trail?.run?.run_selection.display_at_dispatch;
            return <button key={option.user.id} type="button" className={styles.alternative}
              aria-current={option.current || undefined}
              disabled={!option.current && command.kind !== "Idle"}
              onClick={() => void choose(option)}>
              <span className={styles.alternativeHead}>
                <strong>{option.user.fork_title || `alternative ${ordinal + 1}`}</strong>
                {option.current ? <span className={styles.badge}>current</span> : null}
              </span>
              <AlternativePreview alternative={option} />
              <span className={styles.faint}>{shown ? [shown.model_label, shown.route_label, shown.reasoning_label].join(" · ") : "model not recorded"} · {responseState(option.answer)}</span>
            </button>;
          })}
        </div>
      </Dialog>
    </>
  );
});

function responseState(answer: Message | null): string {
  if (!answer) return "no response";
  if (answer.trust_trail?.run?.failure?.code === "invalid_output") return "invalid response";
  switch (answer.status) {
    case "pending": return "response pending";
    case "complete": return "complete";
    case "error": return "failed";
    case "cancelled": return "cancelled";
  }
}

function AlternativePreview({ alternative: { user, answer } }: { alternative: Alternative }) {
  if (!answer) return <span>prompt: <TextPreview content={user.content} /></span>;
  if (answer.trust_trail?.run?.failure?.code === "invalid_output") return <span>response withheld: invalid output</span>;
  if (answer.status === "pending") return null;
  if (!answer.content.trim()) return <span>no saved response text</span>;
  return <span>{answer.status === "error" || answer.status === "cancelled" ? <span className={styles.faint}>partial response</span> : null}<MarkdownPreview content={answer.content} /></span>;
}

/** The inspector's Forks tab: every user turn as an outline to search, open, rename, delete. */
export function ForksPanel({
  tree,
  pathIds,
  onOpen,
  onRename,
  onDelete,
}: {
  tree: Children;
  pathIds: ReadonlySet<string>;
  onOpen(leafId: string, userId: string): Promise<CommandOutcome>;
  onRename(userId: string, title: string | null): Promise<boolean>;
  onDelete(userId: string): Promise<CommandOutcome>;
}) {
  const rows = useMemo(() => outline(tree, pathIds), [tree, pathIds]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(
    null,
  );
  const needle = query.trim().toLowerCase();
  const visible = rows.filter(({ user }) => {
    const answer = tree.get(user.id)?.find((m) => m.role === "assistant");
    const texts = [
      user.content,
      user.fork_title,
      anchorQuote(user),
      answer?.content,
    ];
    return texts.some((text) => text?.toLowerCase().includes(needle));
  });
  const action = (
    text: string,
    onClick: () => void,
    label?: string,
    variant: "ghost" | "danger" = "ghost",
  ) => (
    <Button variant={variant} size="sm" aria-label={label} onClick={onClick}>
      {text}
    </Button>
  );
  return (
    <div className={styles.panel}>
      <label className={styles.search}>
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search forks"
          placeholder="Search forks"
        />
      </label>
      <p className={styles.faint} aria-live="polite">
        {visible.length} {visible.length === 1 ? "fork" : "forks"} found
      </p>
      <ul className={styles.outline} aria-label="Conversation forks">
        {visible.map((row) => {
          const id = row.user.id;
          const title = titleOf(row, 90);
          const quote = anchorQuote(row.user);
          return (
            <li
              key={id}
              data-active={row.current}
              style={{ "--depth": row.depth } as CSSProperties}
            >
              {editing?.id === id ? (
                <form
                  className={styles.actions}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const next = editing.title.trim() || null;
                    void onRename(id, next).then(
                      (ok) => ok && setEditing(null),
                    );
                  }}
                >
                  <input
                    autoFocus
                    value={editing.title}
                    maxLength={120}
                    onChange={(event) =>
                      setEditing({ id, title: event.target.value })
                    }
                    aria-label={`Rename fork ${title}`}
                  />
                  <Button
                    type="submit"
                    variant="secondary"
                    size="sm"
                    aria-label={`Save fork ${title}`}
                  >
                    Save
                  </Button>
                  {action("Cancel", () => setEditing(null))}
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className={styles.outlineTitle}
                    aria-label={`Open fork ${title}`}
                    onClick={() => void onOpen(row.leafId, id)}
                  >
                    {title}
                    {row.current ? (
                      <span className={styles.badge}>Active path</span>
                    ) : null}
                  </button>
                  {quote ? (
                    <blockquote>{truncateText(quote, 120)}</blockquote>
                  ) : null}
                  <span className={styles.actions}>
                    <span className={styles.faint}>{responseState(row.answer)}</span>
                    {action(
                      "Rename",
                      () =>
                        setEditing({ id, title: row.user.fork_title ?? "" }),
                      `Rename fork ${title}`,
                    )}
                    {action("Delete", () => void onDelete(id), `Delete fork ${title}`)}
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
