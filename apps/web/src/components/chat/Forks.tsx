"use client";

import { memo, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { GitBranch, Search } from "lucide-react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { MarkdownPreview, TextPreview } from "@/components/ui/MarkdownMessage";
import type { CommandOutcome } from "@/lib/chat/commands";
import {
  anchorQuote,
  outline,
  type Alternative,
  type Children,
} from "@/lib/chat/tree";
import type { Message } from "@/lib/chat/wire";
import { conversationViewHref } from "@/lib/chat/view";
import { requirePaneRuntime, usePaneParam, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { truncateText } from "@/lib/display/format";
import footerStyles from "./MessageFooter.module.css";
import styles from "./ChatPanels.module.css";

/** A stable split-point control. Choosing a branch never edits the saved tree. */
export const AlternativeSelector = memo(function AlternativeSelector({
  options, parentId, onOpen, onRootSelected, region,
}: {
  options: readonly Alternative[];
  parentId: string | null;
  onOpen(leafId: string, anchorId: string | null): void;
  onRootSelected(userId: string): void;
  region: RefObject<HTMLDivElement | null>;
}) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "AlternativeSelector");
  const conversationId = usePaneParam("id");
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const skipReturn = useRef(false);
  if (!options.length || !conversationId) return null;
  const index = options.findIndex((option) => option.current);
  const activate = (event: TargetActivationEvent, option: Alternative) => {
    const result = activateTargetLink({ event, runtime,
      target: { href: conversationViewHref(conversationId, option.leafId) },
      onDefault: () => {
        onOpen(option.leafId, parentId);
        if (parentId === null) onRootSelected(option.user.id);
      },
    });
    if (result !== "handled-default" && result !== "handled-new-pane") return;
    skipReturn.current = result === "handled-new-pane" || parentId === null;
    setOpen(false);
  };
  return <>
    <button type="button" className={footerStyles.control} aria-haspopup="dialog"
      aria-expanded={open} aria-label={index < 0 ? `continuations, ${options.length}` : `alternatives, ${index + 1} of ${options.length}`}
      onClick={(event) => { opener.current = event.currentTarget; skipReturn.current = false; setOpen(true); }}>
      <GitBranch size={16} aria-hidden="true" />{index < 0 ? "continuations" : `${index + 1} / ${options.length}`}
    </button>
    <Dialog open={open} onClose={() => setOpen(false)} title={index < 0 ? "continuations" : "alternatives"}
      initialFocus={(panel) => panel.querySelector<HTMLElement>('[aria-current="true"], a')}
      returnFocusTo={() => opener.current?.isConnected ? { element: opener.current, preventScroll: true } : null}
      returnFocusFallback={() => region.current ? { element: region.current, preventScroll: true } : null}
      skipReturnFocus={() => skipReturn.current}>
      <div className={styles.alternatives}>
        {options.map((option, ordinal) => {
          const shown = option.answer?.trust_trail?.run?.run_selection.display_at_dispatch;
          return <a key={option.user.id} className={styles.alternative}
            href={conversationViewHref(conversationId, option.leafId)} data-workspace-rich-target="true"
            aria-current={option.current || undefined}
            onClick={(event) => activate(event, option)} onKeyDown={(event) => activate(event, option)}>
            <span className={styles.alternativeHead}>
              <strong>{option.user.fork_title || `alternative ${ordinal + 1}`}</strong>
              {option.current ? <span className={styles.badge}>current</span> : null}
            </span>
            <AlternativePreview alternative={option} />
            <span className={styles.faint}>{shown ? [shown.model_label, shown.route_label, shown.reasoning_label].join(" · ") : "model not recorded"} · {responseState(option.answer)}</span>
          </a>;
        })}
      </div>
    </Dialog>
  </>;
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
  onOpen(leafId: string, userId: string): void;
  onRename(userId: string, title: string | null): Promise<boolean>;
  onDelete(userId: string): Promise<CommandOutcome>;
}) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "ForksPanel");
  const conversationId = usePaneParam("id");
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
  const activate = (event: TargetActivationEvent, leafId: string, userId: string) => {
    if (!conversationId) return;
    activateTargetLink({ event, runtime, target: { href: conversationViewHref(conversationId, leafId) }, onDefault: () => onOpen(leafId, userId) });
  };
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
          const title = row.user.fork_title || truncateText(row.user.content, 90);
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
                  <a
                    href={conversationId ? conversationViewHref(conversationId, row.leafId) : undefined}
                    data-workspace-rich-target="true"
                    className={styles.outlineTitle}
                    aria-label={`Open fork ${title}`}
                    onClick={(event) => activate(event, row.leafId, id)}
                    onKeyDown={(event) => activate(event, row.leafId, id)}
                  >
                    {title}
                    {row.current ? (
                      <span className={styles.badge}>current</span>
                    ) : null}
                  </a>
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
