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
import { watchWritingResource, type WritingWatch, type WritingVersions } from "@/lib/api/writingReceive";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { useCatalogState } from "@/lib/catalog/provider";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { creditName, selectMediaAuthors } from "@/lib/contributors/credits";
import { useImports } from "@/lib/imports/ImportsProvider";
import { mediaKindLabel } from "@/lib/media/kind";
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
interface TitleResult {
  items: Item[];
  generations: ReadonlyMap<WritingWatch, { ref: string; generation: number }>;
}

export type PanePresentation = {
  title: string;
  /** The real name `title` shows; null while `title` is a placeholder (kind noun, loading, unavailable, untitled). */
  name: string | null;
  detail: string | null;
  status: "Ready" | "Unsaved" | "Loading" | "Unresolved" | "Unavailable" | "Failed";
};

export const PANE_TITLES_FAILED = "couldn’t refresh pane titles.";

interface Presentations {
  forVisit(visit: PaneVisit): PanePresentation;
  resourceRefForVisit(visit: PaneVisit): string | null;
  retryTitles(): void;
}
const Context = createContext<Presentations | null>(null);

/** The route's own noun (a daily page is a page), unless media names its kind. */
function kindOf(route: ResolvedPaneRouteModel, canonical: Canonical | null | undefined): string {
  if (canonical && canonical.media_kind !== null) return mediaKindLabel(canonical.media_kind);
  return route.id === "dailyDate" ? "page" : route.defaultLabel.toLowerCase();
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
  watches: { readonly current: ReadonlyMap<string, WritingWatch> };
  publish(key: string, status: ReadStatus, result: TitleResult | null): void;
}) {
  const read = usePaneFreeServerValue({
    key: `workspace-presentations:${props.requestKey}`,
    stale: "",
    load: async signal => {
      const generations = new Map([...props.watches.current].map(([ref, watch]) => [watch, { ref, generation: watch.capture() }]));
      return { items: await readTitles(props.locators, signal), generations };
    },
  });
  const result = read.status === "ready" ? read.data : null;
  const status = read.status === "failed" || (read.status === "ready" && read.error)
    ? "Failed" : read.status === "ready" ? "Ready" : "Loading";
  const { requestKey, publish } = props;
  useEffect(() => publish(requestKey, status, result), [requestKey, status, result, publish]);
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
  const catalog = useCatalogState().data;
  const changes = useChangeStamp("Libraries", "Entries", "Metadata", "Podcasts", "Chats");
  const { observation } = useImports();
  const foreground = useRefreshStamp(true, 0);
  const [revision, setRevision] = useState(0);
  const latestKey = useRef<string | null>(null);
  const watches = useRef(new Map<string, WritingWatch>());
  const retryTitles = useCallback(() => {
    // invalidate immediately; a reply cannot publish before react commits the rerender.
    latestKey.current = null;
    setRevision(value => value + 1);
  }, []);
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
  latestKey.current = requestKey;
  const [read, setRead] = useState<{
    key: string | null;
    status: ReadStatus;
    facts: ReadonlyMap<string, Canonical | null>;
  }>(() => ({ key: null, status: "Loading", facts: new Map() }));
  const publish = useCallback((key: string, status: ReadStatus, result: TitleResult | null) => {
    if (latestKey.current !== key) return;
    if (status === "Ready" && result) {
      const facts = new Map(result.items.flatMap(item => item.presentation?.resource_ref ? [[item.presentation.resource_ref, item.presentation] as const] : []));
      for (const [watch, { ref, generation }] of result.generations) {
        const fact = facts.get(ref);
        const lane = ref.startsWith("page:") ? "title_version" : ref.startsWith("note_block:") ? "body_version" : null;
        if (lane !== null && fact?.text_version != null) watch.adopt({ [lane]: fact.text_version }, generation);
      }
    }
    setRead(previous => ({
      key,
      status,
      facts: status === "Ready" && result
        ? new Map(result.items.map(item => [panePresentationLocatorKey(item.locator), item.presentation]))
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

  const watched = useMemo(() => {
    const refs = new Map<string, number | null>();
    for (const locator of locators) {
      const canonical = read.facts.get(panePresentationLocatorKey(locator));
      const ref = canonical?.resource_ref ?? (locator.kind === "resource_ref" ? locator.ref : null);
      if (ref && /^(page|note_block|media|highlight):/.test(ref)) refs.set(ref, canonical?.text_version ?? null);
    }
    return refs;
  }, [locators, read.facts]);
  useEffect(() => {
    const owned = watches.current;
    return () => { for (const current of owned.values()) current.stop(); owned.clear(); };
  }, [props.accountId]);
  useEffect(() => {
    const owned = watches.current;
    for (const [ref, current] of owned) {
      if (watched.has(ref)) continue;
      current.stop(); owned.delete(ref);
    }
    for (const [ref, version] of watched) {
      if (owned.has(ref)) continue;
      const lane = ref.startsWith("page:") ? "title_version" : ref.startsWith("note_block:") ? "body_version" : null;
      const current = watchWritingResource({ accountId: props.accountId, ref, lanes: lane === null ? [] : [lane],
        invalidate: retryTitles,
        acknowledge(ack) {
          const versions: WritingVersions = {};
          const text = readTextTitle(ref);
          if (lane === "body_version") {
            const note = ack.notes.find(note => `note_block:${note.id}` === ref);
            if (note && text?.acknowledged && text.acknowledged.version >= note.body_version)
              versions.body_version = note.body_version;
          } else if (lane === "title_version") {
            const page = ack.pages.find(page => `page:${page.id}` === ref);
            if (page && text?.acknowledged && text.acknowledged.version >= page.title_version)
              versions.title_version = page.title_version;
          }
          return versions;
        },
      });
      if (lane !== null && version !== null) current.adopt({ [lane]: version }, current.capture());
      owned.set(ref, current);
    }
  }, [props.accountId, watched, retryTitles]);
  useEffect(() => subscribeLinkMutations(change => {
    if (change.kind === "resource_deleted" && watches.current.has(change.ref)) retryTitles();
  }), [retryTitles]);

  const status = read.key === requestKey ? read.status : "Loading";
  const forVisit = useCallback((visit: PaneVisit): PanePresentation => {
    const route = resolvePaneRouteModel(visit.href);
    if (route.labelMode === "static") return { title: route.defaultLabel, name: route.defaultLabel, detail: null, status: "Ready" };
    let kind = kindOf(route, route.titleKey && retained.has(route.titleKey) ? read.facts.get(route.titleKey) : null);
    if (!route.titleKey) return { title: `unavailable ${kind}`, name: null, detail: "unavailable", status: "Unavailable" };
    const current = retained.has(route.titleKey);
    const canonical = current ? read.facts.get(route.titleKey) : undefined;
    // Saved titles are display evidence only: never canonical facts, versions or
    // writer acknowledgements. An authoritative missing result still wins.
    let savedTitle: string | null = null;
    if (canonical === undefined && catalog !== null && route.titleLocator?.kind === "resource_ref") {
      const [scheme, id] = route.titleLocator.ref.split(":");
      if (scheme === "media") {
        const summary = catalog.media.get(id)?.summary;
        if (summary) { savedTitle = summary.title; kind = mediaKindLabel(summary.media_kind); }
      } else if (scheme === "library") savedTitle = catalog.libraries.get(id)?.value.name ?? null;
      else if (scheme === "podcast") savedTitle = catalog.shows.get(id)?.detail.podcast.title ?? null;
      else if (scheme === "page") savedTitle = catalog.notes.get(id)?.title ?? null;
      else if (scheme === "conversation") savedTitle = catalog.chats.get(id)?.title ?? null;
    }
    const text = textFor(route, canonical, dailyRefs);
    const live = text && !text.gone && text.unsettled ? text : null;
    const settled = settledTitle(canonical, text);
    const title = live?.title ?? settled ?? savedTitle ?? visit.title_hint;
    const name = title?.trim() ? title : null;
    const named = title === null ? null : name ?? `untitled ${kind}`;
    if (live && live.acknowledged === null) {
      return { title: named ?? `untitled ${kind}`, name, detail: "unsaved", status: "Unsaved" };
    }
    if (!current) {
      return named
        ? { title: named, name, detail: live ? "unsaved" : kind, status: live ? "Unsaved" : "Ready" }
        : { title: kind, name: null, detail: "open to load title", status: "Unresolved" };
    }
    if (savedTitle !== null) return { title: named ?? `untitled ${kind}`, name, detail: kind, status: "Ready" };
    if (status === "Failed") return {
      title: named ?? kind,
      name,
      detail: named ? "couldn’t refresh title" : "couldn’t load title",
      status: "Failed",
    };
    if (status === "Loading") return {
      title: named ?? "loading title…",
      name,
      detail: named ? "loading title…" : kind,
      status: "Loading",
    };
    if (canonical === null) return {
      title: live ? live.title.trim() ? live.title : `untitled ${kind}`
        : visit.title_hint ?? `unavailable ${kind}`,
      name: live ? name : visit.title_hint,
      detail: live || visit.title_hint ? "removed or no longer accessible" : "unavailable",
      status: "Unavailable",
    };
    if (live) return { title: named ?? `untitled ${kind}`, name, detail: "unsaved", status: "Unsaved" };
    return { title: named ?? `untitled ${kind}`, name, detail: canonical ? metadata(canonical, kind) : kind, status: "Ready" };
  }, [read.facts, retained, dailyRefs, status, catalog]);
  const resourceRefForVisit = useCallback((visit: PaneVisit): string | null => {
    const route = resolvePaneRouteModel(visit.href);
    const canonical = route.titleKey && retained.has(route.titleKey) ? read.facts.get(route.titleKey) : null;
    return canonical?.resource_ref ?? (route.locator?.kind === "resource_ref" ? route.locator.ref : null);
  }, [read.facts, retained]);
  // local titles notify consumers directly; context tracks canonical presentation state.
  const value = useMemo(() => ({ forVisit, resourceRefForVisit, retryTitles }),
    [forVisit, resourceRefForVisit, retryTitles]);

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
    <Context value={value}>
      {requestKey !== null ? (
        <TitleReadBoundary key={requestKey} requestKey={requestKey} failed={failed}>
          <TitleRead requestKey={requestKey} locators={locators} watches={watches} publish={publish} />
        </TitleReadBoundary>
      ) : null}
      {props.children}
    </Context>
  );
}

export function useWorkspacePresentations(): Presentations {
  const value = useContext(Context);
  const revision = useTextTitleRevision();
  const presentations = useMemo(() => {
    void revision;
    return value === null ? null : { ...value };
  }, [value, revision]);
  if (!presentations) throw new Error("workspace presentations require their account provider");
  return presentations;
}
