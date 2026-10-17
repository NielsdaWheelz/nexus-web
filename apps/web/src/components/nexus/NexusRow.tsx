"use client";

// Row parts: the body, resource menu, open-menu request, and source failures.
import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import ResourceBody, { ResourceMatchEvidence } from "@/components/resources/ResourceBody";
import { NO_ACTIONS, useResourceActionMenu } from "@/lib/actions/useResourceActionMenu";
import type { NexusRow, NexusSource } from "@/lib/nexus/model";
import { rowFacts } from "@/lib/nexus/rows";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import styles from "./Nexus.module.css";

type MenuProps = Omit<ComponentProps<typeof ActionMenu>, "options">;

export function NexusRowBody({ row, desktop }: { row: NexusRow; desktop: boolean }) {
  const Icon = row.icon;
  const facts = rowFacts(row, desktop);
  const excerptId = !desktop && row.match ? `mobile-nexus-excerpt-${encodeURIComponent(row.key)}` : undefined;
  return (
    <>
      <span className={styles.rowIcon} aria-hidden="true">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div className={styles.rowBody}>
        {row.item ? (
          <div className={styles.rowLabel} id={row.item.preview.body.kind === "named" ? undefined : excerptId}>
            <ResourceBody body={row.item.preview.body} match={row.match} />
          </div>
        ) : <span className={styles.rowLabel}>{row.label}</span>}
        {facts ? <span className={styles.rowMeta}>{facts}</span> : null}
        {row.item?.preview.body.kind === "named" && row.match ? (
          <div className={styles.rowSnippet} id={excerptId}><ResourceMatchEvidence match={row.match} /></div>
        ) : null}
        {row.action.kind === "Unavailable" ? <span className={styles.rowUnavailable}>{row.action.reason}</span> : null}
      </div>
    </>
  );
}

function ResourceMenu({ resourceRef, menuProps }: { resourceRef: CanonicalResourceRef; menuProps: MenuProps }) {
  const { options, onOpenChange: fetchOnOpen } = useResourceActionMenu(resourceRef);
  const upstreamOpenChange = menuProps.onOpenChange;
  const onOpenChange = useCallback((open: boolean) => {
    upstreamOpenChange?.(open);
    fetchOnOpen(open);
  }, [fetchOnOpen, upstreamOpenChange]);
  return (
    <ActionMenu
      options={options.length > 0 ? options : [NO_ACTIONS]}
      {...menuProps}
      onOpenChange={onOpenChange}
    />
  );
}

/** Only a resource action is a menu; direct tab close never enters its registry. */
export function NexusRowMenu({ row, menuProps }: { row: NexusRow; menuProps: MenuProps }) {
  return row.secondary?.kind === "ResourceMenu"
    ? <ResourceMenu resourceRef={row.secondary.resourceRef} menuProps={menuProps} />
    : null;
}

/** Registers each row's ⋯ trigger by key and clicks the requested one (Cmd/Ctrl+K on the active row). */
export function useNexusRowMenus(request: { readonly seq: number; readonly key: string } | null) {
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const handled = useRef(request?.seq);
  useEffect(() => {
    if (!request || request.seq === handled.current) return;
    handled.current = request.seq;
    triggers.current.get(request.key)?.click();
  }, [request]);
  return useCallback(
    (key: string) => (node: HTMLButtonElement | null) => {
      if (node) triggers.current.set(key, node);
      else triggers.current.delete(key);
    },
    [],
  );
}

export function NexusSourceFailures({ failures, retry, retrying, returnFocus, announce = true }: {
  failures: ReadonlySet<NexusSource>;
  retry(source: NexusSource): void;
  retrying: ReadonlySet<NexusSource>;
  returnFocus: () => HTMLElement | null;
  announce?: boolean;
}) {
  if (failures.size === 0) return null;
  return (
    <div className={styles.failures}>
      {[...failures].map((source) => (
        <FeedbackNotice
          key={source}
          content={{ tone: "Warning", title: source === "Openables" ? "resources couldn’t be searched" : "library contents couldn’t be searched" }}
          announcement={announce ? "Polite" : "None"}
          actions={[{ label: "retry", onClick: () => retry(source), busy: retrying.has(source) }]}
          returnFocus={returnFocus}
        />
      ))}
    </div>
  );
}

export function NexusTitleFailure({ failed, retry, returnFocus, announce = true }: { failed: boolean; retry(): void; returnFocus?: () => HTMLElement | null; announce?: boolean }) {
  return failed ? (
    <div className={styles.failures}>
      <FeedbackNotice
        content={{ tone: "Warning", title: "couldn’t refresh tab titles." }}
        announcement={announce ? "Polite" : "None"}
        actions={[{ label: "retry", onClick: retry }]}
        returnFocus={returnFocus}
      />
    </div>
  ) : null;
}
