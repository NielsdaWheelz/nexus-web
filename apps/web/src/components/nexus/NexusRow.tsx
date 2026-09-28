"use client";

// Row parts both Nexus shells share: the body, the ⋯ menu, the open-menu request, and source failures.
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import { useResourceActionMenuModel } from "@/lib/actions/resourceActionRuntime";
import type { NexusRow, NexusSource } from "@/lib/nexus/model";
import { rowFacts } from "@/lib/nexus/rows";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
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
          <span className={styles.rowSnippet}>
            <EmphasisSegments segments={row.snippet} emphasisClassName={styles.rowSnippetMatch} />
          </span>
        ) : null}
        {row.action.kind === "Unavailable" ? <span className={styles.rowUnavailable}>{row.action.reason}</span> : null}
      </span>
      {row.shortcut ? <kbd className={styles.rowShortcut}>{row.shortcut}</kbd> : null}
    </>
  );
}

function ResourceMenu({ subject, menuProps }: { subject: ResourceActionSubject; menuProps: MenuProps }) {
  const model = useResourceActionMenuModel(subject);
  return (
    <ActionMenu
      options={model.descriptors}
      triggerDisabled={model.triggerDisabled}
      triggerDisabledReason={model.triggerDisabledReason}
      {...menuProps}
    />
  );
}

/** A resource row's menu is the one shared resource menu; a tab row's is "Close tab". */
export function NexusRowMenu({ row, closePane, menuProps }: { row: NexusRow; closePane(paneId: string): void; menuProps: MenuProps }) {
  // ActionMenu re-reports its open state whenever this callback changes; keep it stable.
  const onOpenChange = useRef(menuProps.onOpenChange);
  onOpenChange.current = menuProps.onOpenChange;
  const stableOpenChange = useCallback((open: boolean) => onOpenChange.current?.(open), []);
  const props = { ...menuProps, onOpenChange: stableOpenChange };
  if (row.menu?.kind === "Resource") return <ResourceMenu subject={row.menu.subject} menuProps={props} />;
  if (row.menu?.kind !== "Tab") return null;
  const paneId = row.menu.paneId;
  return (
    <ActionMenu
      options={[
        {
          kind: "command",
          id: "close",
          label: "Close tab",
          icon: <X size={16} aria-hidden="true" />,
          restoreFocusOnClose: false,
          onSelect: () => closePane(paneId),
        },
      ]}
      {...props}
    />
  );
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

export function NexusSourceFailures({ failures, retry }: { failures: ReadonlySet<NexusSource>; retry(source: NexusSource): void }) {
  if (failures.size === 0) return null;
  return (
    <div className={styles.failures} aria-live="polite">
      {[...failures].map((source) => (
        <p key={source}>
          {source === "Openables" ? "Couldn’t search your resources." : "Couldn’t search inside your library."}{" "}
          <button type="button" onClick={() => retry(source)}>
            Retry
          </button>
        </p>
      ))}
    </div>
  );
}
