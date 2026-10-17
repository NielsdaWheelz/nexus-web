"use client";

// Row parts: the body, resource menu, open-menu request, and source failures.
import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import { NO_ACTIONS, useResourceActionMenu } from "@/lib/actions/useResourceActionMenu";
import type { NexusRow, NexusSource } from "@/lib/nexus/model";
import { rowFacts } from "@/lib/nexus/rows";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import styles from "./Nexus.module.css";

type MenuProps = Omit<ComponentProps<typeof ActionMenu>, "options">;

export function NexusRowBody({ row, desktop }: { row: NexusRow; desktop: boolean }) {
  const Icon = row.icon;
  const facts = rowFacts(row, desktop);
  return (
    <>
      <span className={styles.rowIcon} aria-hidden="true">
        <Icon size={18} aria-hidden="true" />
      </span>
      <span className={styles.rowBody}>
        <span className={styles.rowLabel}>{row.label}</span>
        {facts ? <span className={styles.rowMeta}>{facts}</span> : null}
        {row.snippet?.length ? (
          <span className={styles.rowSnippet} id={desktop ? undefined : `mobile-nexus-excerpt-${encodeURIComponent(row.key)}`}>
            <EmphasisSegments segments={row.snippet} emphasisClassName={styles.rowSnippetMatch} />
          </span>
        ) : null}
        {row.action.kind === "Unavailable" ? <span className={styles.rowUnavailable}>{row.action.reason}</span> : null}
      </span>
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

export function NexusSourceFailures({ failures, retry, announce = true }: { failures: ReadonlySet<NexusSource>; retry(source: NexusSource): void; announce?: boolean }) {
  if (failures.size === 0) return null;
  return (
    <div className={styles.failures} aria-live={announce ? "polite" : undefined}>
      {[...failures].map((source) => (
        <p key={source}>
          {source === "Openables" ? "couldn’t search your resources." : "couldn’t search inside your library."}{" "}
          <button type="button" onClick={() => retry(source)}>
            retry
          </button>
        </p>
      ))}
    </div>
  );
}

export function NexusTitleFailure({ failed, retry }: { failed: boolean; retry(): void }) {
  return failed ? (
    <div className={styles.failures}>
      <p>couldn’t refresh tab titles. <button type="button" onClick={retry}>retry</button></p>
    </div>
  ) : null;
}
