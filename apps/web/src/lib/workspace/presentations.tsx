"use client";

// Titles belong to the workspace, not to mounted readers. One account-scoped
// read resolves current locators; visits retain only settled display evidence.
import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { apiFetch } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { creditName, selectMediaAuthors } from "@/lib/contributors/credits";
import { useImports } from "@/lib/imports/ImportsProvider";
import { readTextTitle, useTextTitleRevision, type TextTitle } from "@/lib/notes/texts";
import {
  panePresentationLocatorKey,
  resolvePaneRouteModel,
  type PanePresentationLocator,
  type ResolvedPaneRouteModel,
} from "@/lib/panes/paneRouteModel";
import { reportClientDefect } from "@/lib/telemetry/clientDefects";
import { subscribeLinkMutations } from "@/lib/resourceGraph/links";
import type { PaneVisit } from "@/lib/workspace/model";
import { useWorkspaceStore } from "@/lib/workspace/store";

type Response = ApiJson<"/me/workspace-presentations", "post">;
type Item = Response["data"]["items"][number];
type Canonical = NonNullable<Item["presentation"]>;
type ReadStatus = "Loading" | "Ready" | "Failed";

export type PanePresentation = {
  title: string;
  detail: string | null;
  status: "Ready" | "Unsaved" | "Loading" | "Unresolved" | "Unavailable" | "Failed";
};

interface Presentations {
  forVisit(visit: PaneVisit): PanePresentation;
  retryTitles(): void;
}
const Context = createContext<Presentations | null>(null);
const MEDIA_KIND: Record<Schema<"MediaKind">, string> = {
  web_article: "article", epub: "book", pdf: "pdf", podcast_episode: "episode", video: "video",
};

function kindOf(route: ResolvedPaneRouteModel, canonical: Canonical | null | undefined): string {
  if (canonical?.media_kind) return MEDIA_KIND[canonical.media_kind];
  switch (route.id) {
    case "conversation": return "chat";
    case "podcastDetail": return "podcast";
    case "dailyDate": return "page";
    case "artifact": return "dossier";
    case "oracleReading": return "reading";
    case "browsePreview": return "preview";
    default: return route.defaultLabel.toLowerCase();
  }
}

function metadata(canonical: Canonical, kind: string): string {
  const authors = selectMediaAuthors(canonical.contributors).flatMap(credit => {
    const name = creditName(credit);
    return name ? [name.label] : [];
  });
  const byline = authors.length
    ? `${authors.slice(0, 2).join(", ")}${authors.length > 2 ? ` +${authors.length - 2}` : ""}`
    : canonical.source_label;
  return byline ? `${byline} · ${kind}` : kind;
}

function textFor(
  route: ResolvedPaneRouteModel,
  canonical: Canonical | null | undefined,
  dailyRefs: ReadonlyMap<string, string>,
): TextTitle | null {
  const locator = route.titleLocator;
  const ref = canonical?.resource_ref ?? (
    locator?.kind === "resource_ref" ? locator.ref
      : locator?.kind === "daily_date" ? dailyRefs.get(locator.local_date) : null
  );
  return ref && (ref.startsWith("page:") || ref.startsWith("note_block:")) ? readTextTitle(ref) : null;
}

/** Canonical and acknowledged text use the same version lane for display and hints. */
function settledTitle(canonical: Canonical | null | undefined, text: TextTitle | null): string | null {
  const acknowledged = !text?.gone ? text?.acknowledged : null;
  if (acknowledged && (canonical?.text_version == null || acknowledged.version >= canonical.text_version)) {
    return acknowledged.title;
  }
  return canonical?.title ?? null;
}

async function readTitles(locators: readonly PanePresentationLocator[], signal: AbortSignal): Promise<Item[]> {
  const items: Item[] = [];
  // Panes are uncapped. Keep each request within the endpoint's real limit,
  // with one read lifecycle and bounded concurrency across the whole workspace.
  for (let offset = 0; offset < locators.length; offset += 100) {
    const request: Schema<"WorkspacePresentationsRequest"> = { locators: locators.slice(offset, offset + 100) };
    const response = await apiFetch<Response>("/api/me/workspace-presentations", {
      method: "POST", body: JSON.stringify(request), signal,
    });
    items.push(...response.data.items);
  }
  return items;
}

function TitleRead(props: {
  requestKey: string;
  locators: readonly PanePresentationLocator[];
  publish(key: string, status: ReadStatus, items: Item[] | null): void;
}) {
  const read = usePaneFreeServerValue({
    key: props.requestKey,
    stale: "",
    load: signal => readTitles(props.locators, signal),
  });
  const items = read.status === "ready" ? read.data : null;
  const status = read.status === "failed" || (read.status === "ready" && read.error)
    ? "Failed" : read.status === "ready" ? "Ready" : "Loading";
  const { requestKey, publish } = props;
  useEffect(() => publish(requestKey, status, items), [requestKey, status, items, publish]);
  return null;
}

class TitleReadBoundary extends Component<{
  requestKey: string;
  failed(key: string): void;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportClientDefect(error, { paneId: "workspace-titles", visitId: "workspace-titles", componentStack: info.componentStack ?? "" });
    this.props.failed(this.props.requestKey);
  }
  render() { return this.state.failed ? null : this.props.children; }
}

export function WorkspacePresentationsProvider(props: { accountId: string; children: ReactNode }) {
  const { state, dailyPageByPaneId, setVisitTitleHint } = useWorkspaceStore();
  const textRevision = useTextTitleRevision();
  const changes = useChangeStamp("Libraries", "Entries", "Metadata", "Podcasts", "Chats", "Notes");
  const { observation } = useImports();
  const foreground = useRefreshStamp(true, 0);
  const [revision, setRevision] = useState(0);
  const retryTitles = useCallback(() => setRevision(value => value + 1), []);
  // A contributor can lose its last visible graph edge without a metadata write.
  useEffect(() => subscribeLinkMutations(retryTitles), [retryTitles]);
  const dailyRefs = useMemo(() => {
    const refs = new Map<string, string>();
    for (const pane of state.panes) {
      const known = dailyPageByPaneId.get(pane.id);
      if (known?.routeKey === resolvePaneRouteModel(pane.current_visit.href).routeKey && known.value.pageId) {
        refs.set(known.value.localDate, `page:${known.value.pageId}`);
      }
    }
    return refs;
  }, [state.panes, dailyPageByPaneId]);
  const locators = useMemo(() => {
    const unique = new Map<string, PanePresentationLocator>();
    for (const pane of state.panes) {
      const locator = resolvePaneRouteModel(pane.current_visit.href).titleLocator;
      if (locator) unique.set(panePresentationLocatorKey(locator), locator);
    }
    return [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([, locator]) => locator);
  }, [state.panes]);
  const retained = useMemo(() => new Set(locators.map(panePresentationLocatorKey)), [locators]);
  const locatorSignature = JSON.stringify([...retained]);
  const requestKey = locators.length === 0 ? null
    : JSON.stringify([props.accountId, locatorSignature, changes, observation, foreground, revision]);
  const latestKey = useRef(requestKey);
  latestKey.current = requestKey;
  const [read, setRead] = useState<{
    key: string | null;
    status: ReadStatus;
    facts: ReadonlyMap<string, Canonical | null>;
  }>(() => ({ key: null, status: "Loading", facts: new Map() }));
  const publish = useCallback((key: string, status: ReadStatus, items: Item[] | null) => {
    if (latestKey.current !== key) return;
    setRead(previous => ({
      key,
      status,
      facts: status === "Ready" && items
        ? new Map(items.map(item => [panePresentationLocatorKey(item.locator), item.presentation]))
        : previous.facts,
    }));
  }, []);
  const failed = useCallback((key: string) => publish(key, "Failed", null), [publish]);
  useEffect(() => {
    setRead(previous => {
      if ([...previous.facts.keys()].every(key => retained.has(key))) return previous;
      return { ...previous, facts: new Map([...previous.facts].filter(([key]) => retained.has(key))) };
    });
  }, [retained]);

  const status = read.key === requestKey ? read.status : "Loading";
  const forVisit = (visit: PaneVisit): PanePresentation => {
    const route = resolvePaneRouteModel(visit.href);
    if (route.labelMode === "static") return { title: route.defaultLabel, detail: null, status: "Ready" };
    const kind = kindOf(route, route.titleKey && retained.has(route.titleKey) ? read.facts.get(route.titleKey) : null);
    if (!route.titleKey) return { title: `unavailable ${kind}`, detail: "unavailable", status: "Unavailable" };
    const current = retained.has(route.titleKey);
    const canonical = current ? read.facts.get(route.titleKey) : undefined;
    const text = textFor(route, canonical, dailyRefs);
    const live = text && !text.gone && text.unsettled ? text : null;
    const settled = settledTitle(canonical, text);
    const title = live?.title ?? settled ?? visit.title_hint;
    const named = title === null ? null : title.trim() ? title : `untitled ${kind}`;
    if (live && live.acknowledged === null) {
      return { title: named ?? `untitled ${kind}`, detail: "unsaved", status: "Unsaved" };
    }
    if (!current) {
      return named
        ? { title: named, detail: live ? "unsaved" : kind, status: live ? "Unsaved" : "Ready" }
        : { title: kind, detail: "open to load title", status: "Unresolved" };
    }
    if (status === "Failed") return {
      title: named ?? kind,
      detail: named ? "couldn’t refresh title" : "couldn’t load title",
      status: "Failed",
    };
    if (status === "Loading") return {
      title: named ?? "loading title…",
      detail: named ? "loading title…" : kind,
      status: "Loading",
    };
    if (canonical === null) return {
      title: live ? live.title.trim() ? live.title : `untitled ${kind}`
        : visit.title_hint ?? `unavailable ${kind}`,
      detail: live || visit.title_hint ? "removed or no longer accessible" : "unavailable",
      status: "Unavailable",
    };
    if (live) return { title: named ?? `untitled ${kind}`, detail: "unsaved", status: "Unsaved" };
    return { title: named ?? `untitled ${kind}`, detail: canonical ? metadata(canonical, kind) : kind, status: "Ready" };
  };

  useEffect(() => {
    for (const pane of state.panes) {
      const visit = pane.current_visit;
      const route = resolvePaneRouteModel(visit.href);
      if (!route.titleLocator || !route.titleKey || !retained.has(route.titleKey)) continue;
      const canonical = read.facts.get(route.titleKey);
      const title = settledTitle(canonical, textFor(route, canonical, dailyRefs));
      if (title === null) continue;
      setVisitTitleHint({ paneId: pane.id, visitId: visit.id, titleKey: route.titleKey, title });
    }
  }, [state.panes, read.facts, retained, textRevision, dailyRefs, setVisitTitleHint]);

  return (
    <Context value={{ forVisit, retryTitles }}>
      {requestKey !== null ? (
        <TitleReadBoundary key={requestKey} requestKey={requestKey} failed={failed}>
          <TitleRead requestKey={requestKey} locators={locators} publish={publish} />
        </TitleReadBoundary>
      ) : null}
      {props.children}
    </Context>
  );
}

export function useWorkspacePresentations(): Presentations {
  const value = useContext(Context);
  if (!value) throw new Error("workspace presentations require their account provider");
  return value;
}
