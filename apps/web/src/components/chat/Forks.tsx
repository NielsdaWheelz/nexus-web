"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { GitBranch, Search } from "lucide-react";
import Button from "@/components/ui/Button";
import {
  alternatives,
  anchorQuote,
  outline,
  type Alternative,
  type ChatView,
  type Children,
} from "@/lib/chat/tree";
import { truncateText } from "@/lib/display/format";
import styles from "./ChatPanels.module.css";

const titleOf = ({ user }: Alternative, length: number) =>
  user.fork_title || truncateText(user.content, length);

/** The alternatives under one answer (or at the start), inline in the transcript. */
export function ForkStrip({
  view,
  parentId,
  onOpen,
}: {
  view: ChatView;
  parentId: string | null;
  onOpen(leafId: string, anchorId: string | null): void;
}) {
  const options = alternatives(view.children, parentId, view.pathIds);
  if (!options.length) return null;
  const where = parentId ? "from this answer" : "from the start";
  return (
    <section className={styles.strip} aria-label={`Forks ${where}`}>
      <span className={styles.faint}>
        <GitBranch size={14} aria-hidden="true" /> {options.length} fork options
      </span>
      <div className={styles.stripList}>
        {options.map((option) => {
          const { user, current, status } = option;
          const quote = anchorQuote(user);
          const label = [
            current ? "Current fork" : "Switch to fork",
            user.fork_title && `Title: ${user.fork_title}`,
            `Reply: ${user.content}`,
            quote && `Quote: ${quote}`,
            `Status: ${status}`,
          ];
          return (
            <button
              key={user.id}
              type="button"
              className={styles.option}
              data-active={current}
              aria-current={current || undefined}
              aria-label={label.filter(Boolean).join(". ")}
              onClick={() => current || onOpen(option.leafId, parentId)}
            >
              <strong>
                {titleOf(option, 72)}
                {current ? <span className={styles.badge}>Current</span> : null}
              </strong>
              {quote ? (
                <span className={styles.faint}>{truncateText(quote, 96)}</span>
              ) : null}
              <span className={styles.faint}>{status}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
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
  onOpen(leafId: string, userId: string): Promise<void>;
  onRename(userId: string, title: string | null): Promise<boolean>;
  onDelete(userId: string): Promise<void>;
}) {
  const rows = useMemo(() => outline(tree, pathIds), [tree, pathIds]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [confirming, setConfirming] = useState<string | null>(null);
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
                    <span className={styles.faint}>{row.status}</span>
                    {action(
                      "Rename",
                      () =>
                        setEditing({ id, title: row.user.fork_title ?? "" }),
                      `Rename fork ${title}`,
                    )}
                    {confirming !== id ? (
                      action(
                        "Delete",
                        () => setConfirming(id),
                        `Delete fork ${title}`,
                      )
                    ) : (
                      <>
                        Delete this turn and everything after it?
                        {action(
                          "Delete",
                          () =>
                            onDelete(id)
                              .catch(() => undefined) // the store reported it
                              .finally(() => setConfirming(null)),
                          undefined,
                          "danger",
                        )}
                        {action("Cancel", () => setConfirming(null))}
                      </>
                    )}
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
