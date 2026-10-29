"use client";

// Native lists share one host visit's folds and reveal scope; ancestry follows occurrences.
// Structure, selection and editing belong to the outline that renders the rows.
import {createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode} from "react";
import {FeedbackFailure} from "@/components/feedback/Feedback";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import {remoteConnectionsError} from "@/components/connections/RemoteConnections";
import {useOutlineChildren,type OutlineChildrenDescriptor} from "@/lib/resourceGraph/useOutlineChildren";
import {usePaneRuntime} from "@/lib/panes/paneRuntime";
import type {OutlineBranch, OutlineTarget} from "@/lib/resources/outlineProjection";
import {useEditorDraft} from "@/lib/notes/editorHost";
import styles from "./ResourceOutline.module.css";

export const ResourceOutlineContext = createContext<{
  scope: string;
  view: { folds: ReadonlyMap<string, boolean> };
  viewLocked: boolean;
  refreshChildren():void;
  childAvailability: ReturnType<typeof useOutlineChildren>["items"];
  registerChildren(key:string,descriptor:OutlineChildrenDescriptor):()=>void;
  toggle(key: string, open: boolean): void;
  reveal(target: OutlineTarget): void;
} | null>(null);
export const ResourceBranch = createContext<OutlineBranch>({
  ancestors: new Map(),
  traversedEdgeIds: new Set(),
});

type Props = {
  children: ReactNode;
  after?: ReactNode;
  ariaLabel: string;
  scope: string;
  ancestorRef?: string;
  branch?: OutlineBranch;
  onRevealRoot?: () => void;
  onRevealOccurrence?: (key: string) => void;
  busy?: boolean;
  viewLocked?: boolean;
};

export default function ResourceOutlineList(props: Props) {
  const parent = useContext(ResourceOutlineContext);
  const inherited = useContext(ResourceBranch);
  const runtime = usePaneRuntime();
  if (parent)
    return (
      <ResourceBranch value={props.branch ?? inherited}>
        <ul className={styles.list} aria-label={props.ariaLabel} aria-busy={props.busy}>
          {props.children}
        </ul>
        {props.after}
      </ResourceBranch>
    );
  return <RootList key={`${runtime?.visitId ?? "outside"}:${props.scope}`} {...props} />;
}

function RootList({
  children, after, ariaLabel, scope, ancestorRef, branch: suppliedBranch,
  onRevealRoot, onRevealOccurrence, busy, viewLocked = false,
}: Props) {
  const inherited = useContext(ResourceBranch);
  const root = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const folds = useEditorDraft<ReadonlyMap<string, boolean>>(`Resources.OutlineFolds:${scope}`, () => new Map());
  const reveal = useCallback((target: OutlineTarget) => {
    if (target.kind === "root") {
      if (onRevealRoot) onRevealRoot();
      else list.current?.focus();
      return;
    }
    const row = root.current?.querySelector<HTMLElement>(
      `[data-outline-occurrence="${CSS.escape(target.key)}"] [data-row-focusable]`,
    );
    if (row) row.focus(); else onRevealOccurrence?.(target.key);
  }, [onRevealRoot, onRevealOccurrence]);
  const [descriptors,setDescriptors]=useState<ReadonlyMap<string,OutlineChildrenDescriptor>>(()=>new Map());
  const registerChildren=useCallback((key:string,descriptor:OutlineChildrenDescriptor)=>{
    setDescriptors(current=>new Map(current).set(key,descriptor));
    return()=>setDescriptors(current=>{if(current.get(key)!==descriptor)return current;const next=new Map(current);next.delete(key);return next;});
  },[]);
  const availability=useOutlineChildren(scope,descriptors);
  const context = {
    childAvailability:availability.items,registerChildren,refreshChildren:availability.retry,
    scope, view: {folds: folds.value}, viewLocked,
    toggle(key: string, open: boolean) {
      if (!viewLocked) folds.set(current => new Map(current).set(key, open));
    },
    reveal,
  };
  const base = suppliedBranch ?? inherited;
  const branch = useMemo(() => ancestorRef && !base.ancestors.has(ancestorRef)
    ? {...base, ancestors: new Map(base.ancestors).set(ancestorRef, {kind: "root"} as const)}
    : base, [ancestorRef, base]);
  return <ResourceOutlineContext value={context}>
    <ResourceBranch value={branch}>
      <div ref={root} className={styles.outline} data-pane-return-scope={scope} data-outline-scope={scope}>
        <ul ref={list} className={styles.list} aria-label={ariaLabel} aria-busy={busy} tabIndex={-1}>
          {children}
        </ul>
        <AuthoredReadFailure error={availability.error} occurrence={availability.occurrence} pending={availability.pending} retry={availability.retry} title="couldn’t read linked resources on this device"/>
        {availability.remoteError?<FeedbackFailure scope="Local" occurrence={availability.remoteOccurrence} content={remoteConnectionsError(availability.remoteError)} announcement="Polite" actions={[{label:"retry connections",onClick:availability.retry,busy:availability.remotePending}]}/>:null}
        {after}
      </div>
    </ResourceBranch>
  </ResourceOutlineContext>;
}
