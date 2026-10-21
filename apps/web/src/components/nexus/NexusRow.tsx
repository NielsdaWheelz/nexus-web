"use client";

// Row parts: resource bodies, menus, and visible non-announcing search status.
import type { ComponentProps } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import ResourceBody, { ResourceMatchEvidence } from "@/components/resources/ResourceBody";
import ResourceMetadata from "@/components/resources/ResourceMetadata";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import type { NexusRow } from "@/lib/nexus/model";
import { resourceAction, rowFacts } from "@/lib/nexus/rows";
import { resourceMetadata } from "@/lib/resources/metadata";
import type { ActionDescriptor, MenuContent, MenuSource } from "@/lib/ui/actionDescriptor";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";

type MenuProps = Omit<ComponentProps<typeof ActionMenu>, "source">;
type RowActions = Pick<NexusController, "activate" | "closePane">;

export function NexusRowBody({ row, desktop }: { row: NexusRow; desktop: boolean }) {
  const Icon = row.icon;
  const facts = rowFacts(row, desktop);
  const excerptId = !desktop ? `mobile-nexus-excerpt-${encodeURIComponent(row.key)}` : undefined;
  const namedEvidence = row.item?.preview.body.kind === "named" && row.match
    && row.match.excerpt.text !== row.item.preview.body.title ? row.match : null;
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
        {row.item ? <span className={styles.rowMeta}><ResourceMetadata parts={resourceMetadata({ item: row.item, matchMethod: row.matchMethod }).parts} linkSource={false} />{row.state ? ` · ${row.state.toLowerCase()}` : null}</span>
          : facts ? <span className={styles.rowMeta}>{facts}</span> : null}
        {namedEvidence ? (
          <div className={styles.rowSnippet} id={row.matchingPassage ? undefined : excerptId}><ResourceMatchEvidence match={namedEvidence} /></div>
        ) : null}
        {row.matchingPassage ? <div className={styles.rowPassage} id={excerptId}>
          <div className={styles.rowSnippet}><ResourceBody body={row.matchingPassage.item.preview.body} match={row.matchingPassage.match} /></div>
          <span className={styles.rowPassageMeta}><ResourceMetadata parts={resourceMetadata({ item: row.matchingPassage.item, matchMethod: row.matchingPassage.match_method }).parts} linkSource={false} /></span>
        </div> : null}
        {row.action.kind === "Unavailable" ? <span className={styles.rowUnavailable}>{row.action.reason}</span> : null}
      </div>
    </>
  );
}

function ResourceMenu({ row, menuProps, activate, closePane }: { row: NexusRow; menuProps: MenuProps } & RowActions) {
  const secondary = row.secondary;
  const resource = useResourceActions(secondary?.kind === "ResourceMenu" ? secondary.resourceRef : null);
  const state = resource.state;
  const ownOptions: ActionDescriptor[] = [];
  if (row.matchingPassage) {
    const action = resourceAction(row.matchingPassage.item);
    ownOptions.push({ kind: "command", id: "Nexus.OpenMatchingPassage", label: "open matching passage",
      disabled: action.kind === "Unavailable", disabledReason: action.kind === "Unavailable" ? action.reason : undefined,
      onSelect: ({ openIntent }) => activate(action, { disposition: { kind: openIntent === "new_pane" ? "Fork" : "Follow" } }),
    });
  }
  if (secondary?.kind === "ResourceMenu") for (const pane of secondary.closePanes)
    ownOptions.push({ kind: "command", id: `Nexus.CloseTab:${pane.id}`, label: pane.label, onSelect: () => closePane(pane.id) });
  const options = state?.kind === "Ready" ? state.options : [];
  const content: MenuContent = { sections: [
    ...(ownOptions.length ? [{ id: "Occurrence", label: options.length ? "this occurrence" : null, options: ownOptions }] : []),
    ...(options.length ? [{ id: "Resource", label: ownOptions.length ? "item" : null, options }] : []),
  ] };
  const source: MenuSource = {
    kind: "Prepared", subjectKey: `nexus:${row.key}:${secondary?.kind === "ResourceMenu" ? secondary.resourceRef : "none"}`,
    title: row.label, prepare: resource.prepare,
    state: state?.kind === "Ready" ? { kind: "Ready", request: state.request, content } : state,
  };
  return <ActionMenu {...menuProps} source={source} />;
}

/** Only a resource action is a menu; direct tab close keeps its native button. */
export function NexusRowMenu({ row, menuProps, ...actions }: { row: NexusRow; menuProps: MenuProps } & RowActions) {
  return row.secondary?.kind === "ResourceMenu"
    ? <ResourceMenu row={row} menuProps={menuProps} {...actions} />
    : null;
}

/** The screen owns its single live region; this visible status never announces twice. */
export function NexusSearchStatus({ controller, returnFocus }: {
  controller: NexusController;
  returnFocus: () => HTMLElement | null;
}) {
  const { text, action } = controller.searchProgress;
  return <div className={styles.searchStatus}>
    {text ? <FeedbackNotice content={{ tone: controller.searchUnavailable ? "Warning" : "Info", title: text }} announcement="None"
      actions={action === null ? undefined : [{
        label: action === "refresh" ? "refresh results" : action === "related" ? "retry related matches" : "retry search",
        onClick: () => {
          if (action === "refresh") controller.refreshResults();
          else if (action === "related") controller.retryRelated();
          else controller.retrySearch();
          returnFocus()?.focus({ preventScroll: true });
        },
        busy: controller.retrying.size > 0,
      }]} /> : null}
  </div>;
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
