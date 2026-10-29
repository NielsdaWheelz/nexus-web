"use client";
/** Authored titles come from the local graph, even online. Other resource labels
 * retain their server/catalog owner. Saved visit hints are display evidence only. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, apiFetch } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { useAuthoredStore } from "@/lib/authored/provider";
import { useCatalogState } from "@/lib/catalog/provider";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { creditName, selectMediaAuthors } from "@/lib/contributors/credits";
import { useImports } from "@/lib/imports/ImportsProvider";
import { mediaKindLabel } from "@/lib/media/kind";
import { panePresentationLocatorKey, resolvePaneRouteModel, type PanePresentationLocator } from "@/lib/panes/paneRouteModel";
import { pageTitle } from "@nexus/authored/queries";
import { useRecent } from "@/lib/recent/store";
import { recentTargetKey, type RecentEntry } from "@/lib/recent/model";
import { recentValueForHref } from "@/lib/panes/paneRouteModel";
import { normalizeVisitTitleHint, type PaneVisit } from "@/lib/workspace/model";
import { useWorkspaceStore } from "@/lib/workspace/store";
import type { AuthoredStore, ResourceProjection } from "@nexus/authored/types";
import type { OutlineRootMetadata } from "@/components/notes/LocalOutline";
type Canonical = Schema<"WorkspacePresentationOut">;
interface TitleFacts { ref: string; title: string; local_date: string | null }
export const PANE_TITLES_FAILED = "couldn’t refresh pane titles.";
export interface PanePresentation { title: string; name:string|null; detail: string | null; status: "Ready" | "Unsaved" | "Loading" | "Unresolved" | "Unavailable" | "Failed" }
interface Presentations { forVisit(visit: PaneVisit): PanePresentation; forRecent(entry: RecentEntry): PanePresentation; isRecentRemoved(entry: RecentEntry): boolean; holdRecent(entries: readonly RecentEntry[]): void; resourceRefForVisit(visit: PaneVisit): string | null; retryTitles(): void }
const Context = createContext<Presentations | null>(null);
type PublishTitle = (key: string, facts: TitleFacts | null, storeRevision: string, usedRevision?: string) => void;
const PublisherContext = createContext<PublishTitle | null>(null);
function titleFacts(resource: ResourceProjection | null): TitleFacts | null {
  return resource ? {ref: resource.ref, title: resource.title ?? resource.body_text?.split("\n")[0] ?? resource.selection?.quote_exact ?? "", local_date: resource.local_date} : null;
}
/** A successful root read supplies title evidence; unknown/error is never absence. */
export function useNoteRootTitle(ref: string, rootRead: OutlineRootMetadata): void {
  const publish = useContext(PublisherContext);
  if (!publish) throw new Error("note root titles require their account provider");
  useEffect(() => {
    if (!rootRead.known || rootRead.ref !== ref || rootRead.store_revision === null) return;
    publish(panePresentationLocatorKey({kind: "resource_ref", ref}), titleFacts(rootRead.resource), rootRead.store_revision);
  }, [ref, rootRead, publish]);
}
function authored(locator: PanePresentationLocator): boolean { return locator.kind === "daily_date" || locator.kind === "resource_ref" && /^(page|note_block|highlight):/u.test(locator.ref); }
/** One locator owns one bounded read; sibling pane changes do not restart it. */
function AuthoredTitleSubscription({ store, locatorKey, kind, value, usedRevision, publish }: {
  store: AuthoredStore; locatorKey: string; kind: "daily" | "resource"; value: string; usedRevision: string | undefined;
  publish: PublishTitle;
}) {
  useEffect(() => {
    let live = true;
    const stop = store.subscribe(kind === "daily" ? { kind: "daily", local_date: value } : { kind: "resource", ref: value }, result => {
      if (live) publish(locatorKey, titleFacts(result.rows[0]?.resource ?? null), result.store_revision, usedRevision);
    }, reportError);
    return () => { live = false; stop(); };
  }, [store, locatorKey, kind, value, usedRevision, publish]);
  return null;
}
export function WorkspacePresentationsProvider({ accountId, children }: { accountId: string; children: ReactNode }) {
  const { state, setVisitTitleHint } = useWorkspaceStore();
  const recent = useRecent();
  const [heldRecent, setHeldRecent] = useState<readonly RecentEntry[]>([]);
  const holdRecent = useCallback((entries: readonly RecentEntry[]) => setHeldRecent(entries), []);
  const store = useAuthoredStore();
  const catalog = useCatalogState().data;
  const changes = useChangeStamp("Libraries", "Entries", "Metadata", "Podcasts", "Chats");
  const { observation } = useImports();
  const foreground = useRefreshStamp(true, 0);
  const [attempt, retry] = useState(0);
  const locators = useMemo(() => {
    const result = new Map<string, PanePresentationLocator>();
    for (const pane of state.panes) { const locator = resolvePaneRouteModel(pane.current_visit.href).titleLocator; if (locator) result.set(panePresentationLocatorKey(locator), locator); }
    for (const entry of [...recent.snapshot?.entries ?? [], ...heldRecent]) {
      const target = entry.target;
      if (target.kind !== "preview") result.set(panePresentationLocatorKey(target), target);
    }
    return [...result.values()];
  }, [state.panes, recent.snapshot, heldRecent]);
  const [local, setLocal] = useState<{entries: Map<string, {facts: TitleFacts | null; store_revision: string; used_revision?: string}>; semanticRevision: number}>(() => ({entries: new Map(), semanticRevision: 0}));
  const publishLocal = useCallback<PublishTitle>((key, facts, storeRevision, usedRevision) => {
    setLocal(previous => {
      const before = previous.entries.get(key);
      const order = before ? BigInt(storeRevision) - BigInt(before.store_revision) : null;
      if (order !== null && order < 0n) return previous;
      const old = before?.facts;
      const unchanged = old === facts || old !== undefined && old !== null && facts !== null && old.ref === facts.ref && old.title === facts.title && old.local_date === facts.local_date;
      if (order === 0n && unchanged && (usedRevision === undefined || usedRevision === before?.used_revision)) return previous;
      // justify-service-invariant-check: one account revision has one canonical caption per locator.
      if (order === 0n && !unchanged) throw new Error("title facts disagree at the same store revision");
      return {entries: new Map(previous.entries).set(key, {facts, store_revision: storeRevision, used_revision: usedRevision ?? before?.used_revision}), semanticRevision: previous.semanticRevision + (unchanged && usedRevision === undefined ? 0 : 1)};
    });
  }, []);
  const remoteLocators = locators.filter(locator => !authored(locator) && locator.kind !== "x_capture");
  const captureLocators = locators.filter(locator => locator.kind === "x_capture");
  const remoteKey = JSON.stringify([accountId, remoteLocators, recent.snapshot?.entries.map(entry => [recentTargetKey(entry.target), entry.used_revision]), changes, observation, foreground, attempt]);
  const remote = usePaneFreeServerValue({ key: `workspace-presentations:${remoteKey}`, stale: "", load: async signal => {
    const items: ApiJson<"/me/workspace-presentations", "post">["data"]["items"] = [];
    for (let offset = 0; offset < remoteLocators.length; offset += 100) {
      const result = await apiFetch<ApiJson<"/me/workspace-presentations", "post">>("/api/me/workspace-presentations", { method: "POST", body: JSON.stringify({ locators: remoteLocators.slice(offset, offset + 100) }), signal });
      items.push(...result.data.items);
    }
    return new Map(items.map(item => [panePresentationLocatorKey(item.locator), item.presentation]));
  } });
  const captureKey = JSON.stringify([accountId, captureLocators, recent.snapshot?.entries.filter(entry => entry.target.kind === "x_capture").map(entry => [recentTargetKey(entry.target), entry.used_revision]), changes, foreground, attempt]);
  const captures = usePaneFreeServerValue({ key: captureLocators.length ? `capture-presentations:${captureKey}` : null, stale: "", load: async signal => {
    while (!signal.aborted) {
      const { command_seq } = await store.readReplica();
      try { await store.whenUploaded(command_seq, signal); } catch (error) {
        if (signal.aborted) throw error;
        let unavailable = false;
        const stop = store.sync_status((status, detail) => {
          unavailable = ["offline", "sign_in_required", "update_required", "sync_error"].includes(status) || status === "preparing" && detail !== null;
        });
        stop();
        if (unavailable) throw new ApiError(0, "E_NETWORK", "capture presentation unavailable");
        throw error;
      }
      const items: ApiJson<"/me/workspace-presentations", "post">["data"]["items"] = [];
      for (let offset = 0; offset < captureLocators.length; offset += 100) {
        const result = await apiFetch<ApiJson<"/me/workspace-presentations", "post">>("/api/me/workspace-presentations", { method: "POST", body: JSON.stringify({ locators: captureLocators.slice(offset, offset + 100) }), signal });
        items.push(...result.data.items);
      }
      if ((await store.readReplica()).command_seq === command_seq) return new Map(items.map(item => [panePresentationLocatorKey(item.locator), item.presentation]));
    }
    throw new DOMException("aborted", "AbortError");
  } });
  const captureFacts = captures.status === "ready" && !captures.error ? captures.data : null;
  const remoteFacts = remote.status === "ready" ? remote.data : null;
  const remoteStatus = remote.status;
  const remoteFailed = remote.status === "failed" || remote.status === "ready" && Boolean(remote.error);
  const forVisit = useCallback((visit: PaneVisit): PanePresentation => {
    const route = resolvePaneRouteModel(visit.href);
    if (route.labelMode === "static") return { title: route.defaultLabel, name:route.defaultLabel, detail: null, status: "Ready" };
    const locator = route.titleLocator;
    const kind = route.id === "dailyDate" ? "page" : route.defaultLabel.toLowerCase();
    if (!locator) return { title: visit.title_hint ?? kind, name:visit.title_hint, detail: "unavailable", status: "Unavailable" };
    const key = panePresentationLocatorKey(locator);
    if (authored(locator)) {
      const resource = local.entries.get(key)?.facts;
      if (resource === undefined) return { title: visit.title_hint ?? kind, name:visit.title_hint, detail: "loading title…", status: "Loading" };
      if (resource === null) return { title: route.id === "dailyDate" && locator.kind === "daily_date" ? pageTitle("", locator.local_date) : visit.title_hint ?? `unavailable ${kind}`, name:route.id === "dailyDate" && locator.kind === "daily_date" ? pageTitle("", locator.local_date) : visit.title_hint, detail: route.id === "dailyDate" ? "page" : "removed", status: route.id === "dailyDate" ? "Ready" : "Unavailable" };
      const title = resource.title;
      const name = title.trim() ? title : resource.local_date !== null ? pageTitle("", resource.local_date) : null;
      return { title: name ?? route.defaultLabel, name, detail: kind, status: "Ready" };
    }
    const canonical: Canonical | null | undefined = remoteFacts?.get(key);
    let saved: string | null = null;
    if (canonical === undefined && catalog && locator.kind === "resource_ref") {
      const [scheme, id] = locator.ref.split(":");
      if (scheme === "media") saved = catalog.media.get(id)?.summary.title ?? null;
      else if (scheme === "library") saved = catalog.libraries.get(id)?.value.name ?? null;
      else if (scheme === "podcast") saved = catalog.shows.get(id)?.detail.podcast.title ?? null;
      else if (scheme === "conversation") saved = catalog.chats.get(id)?.title ?? null;
    }
    const rawName=canonical?.title ?? saved ?? visit.title_hint;
    const name=rawName?.trim()?rawName:null;
    const title=rawName??kind;
    if (canonical) {
      const noun = canonical.media_kind ? mediaKindLabel(canonical.media_kind) : kind;
      const authors = selectMediaAuthors(canonical.contributors).flatMap(credit => { const name = creditName(credit); return name ? [name.label] : []; });
      const byline = authors.slice(0, 2).join(", ") || canonical.source_label;
      return { title: title.trim() ? title : `untitled ${noun}`, name, detail: byline ? `${byline} · ${noun}` : noun, status: "Ready" };
    }
    if (saved !== null) return { title, name, detail: kind, status: "Ready" };
    if (remoteFailed) return { title, name, detail: "couldn’t refresh title", status: "Failed" };
    if (remoteStatus !== "ready") return { title, name, detail: "loading title…", status: "Loading" };
    return { title, name, detail: "removed or no longer accessible", status: "Unavailable" };
    // Facts change only with semanticRevision; newer watermarks keep this callback's facts equivalent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local.semanticRevision, remoteFacts, remoteStatus, remoteFailed, catalog]);
  const resourceRefForVisit = useCallback((visit: PaneVisit) => {
    const locator = resolvePaneRouteModel(visit.href).titleLocator;
    if (!locator) return null;
    const key = panePresentationLocatorKey(locator);
    return local.entries.get(key)?.facts?.ref ?? remoteFacts?.get(key)?.resource_ref ?? (locator.kind === "resource_ref" ? locator.ref : null);
    // Watermark-only entries changes cannot change any published resource ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local.semanticRevision, remoteFacts]);
  const forRecent = useCallback((entry: RecentEntry): PanePresentation => {
    const fallback = resolvePaneRouteModel(entry.href).defaultLabel;
    if (entry.target.kind === "preview") return { title: entry.title_hint ?? fallback, name: entry.title_hint, detail: entry.detail_hint, status: "Ready" };
    if (entry.target.kind === "x_capture") {
      const fact = captureFacts?.get(panePresentationLocatorKey(entry.target));
      return { title: entry.title_hint ?? fact?.title ?? fallback, name: entry.title_hint ?? fact?.title ?? null, detail: entry.detail_hint ?? "post", status: fact === null ? "Unavailable" : fact ? "Ready" : "Loading" };
    }
    const presentation = forVisit({ id: "", href: entry.href, title_hint: entry.title_hint });
    if (presentation.status !== "Ready") return { ...presentation, title: entry.title_hint ?? (entry.target.kind === "daily_date" ? pageTitle("", entry.target.local_date) : fallback), detail: entry.detail_hint ?? fallback.toLowerCase() };
    return presentation;
  }, [forVisit, captureFacts]);
  const isRecentRemoved = useCallback((entry: RecentEntry): boolean => {
    const target = entry.target;
    if (target.kind === "preview" || target.kind === "daily_date") return false;
    if (target.kind === "x_capture") return captureFacts?.has(panePresentationLocatorKey(target)) === true && captureFacts.get(panePresentationLocatorKey(target)) === null;
    const key = panePresentationLocatorKey(target);
    if (authored(target)) {
      const result = local.entries.get(key);
      return result?.used_revision !== undefined && BigInt(result.used_revision) >= BigInt(entry.used_revision) && result.facts === null;
    }
    return remoteStatus === "ready" && !remoteFailed && remoteFacts?.has(key) === true && remoteFacts.get(key) === null;
  }, [captureFacts, local.entries, remoteStatus, remoteFailed, remoteFacts]);
  useEffect(() => {
    for (const entry of recent.snapshot?.entries ?? []) {
      if (entry.target.kind === "x_capture") {
        if (isRecentRemoved(entry)) recent.reconcile({ target: entry.target, expected_used_revision: entry.used_revision, replacement: null });
        continue;
      }
      if (entry.target.kind === "preview") {
        const visit = state.panes.map(pane => pane.current_visit).find(visit => {
          const value = recentValueForHref(visit.href);
          return value !== null && recentTargetKey(value.target) === recentTargetKey(entry.target);
        });
        const title = normalizeVisitTitleHint(visit?.title_hint ?? null);
        if (title !== null && title !== entry.title_hint) recent.reconcile({ target: entry.target, expected_used_revision: entry.used_revision, replacement: { target: entry.target, href: entry.href, title_hint: title, detail_hint: entry.detail_hint } });
        continue;
      }
      const presentation = forRecent(entry);
      const key = panePresentationLocatorKey(entry.target);
      const localEntry = local.entries.get(key);
      const facts = localEntry?.facts;
      if (authored(entry.target) && localEntry?.used_revision !== entry.used_revision) continue;
      if (entry.target.kind === "resource_ref" && authored(entry.target) && facts === null) {
        recent.reconcile({ target: entry.target, expected_used_revision: entry.used_revision, replacement: null });
        continue;
      }
      if (!authored(entry.target) && remote.status === "ready" && !remote.error && remote.data.has(key) && remote.data.get(key) === null) {
        recent.reconcile({ target: entry.target, expected_used_revision: entry.used_revision, replacement: null });
        continue;
      }
      if (presentation.status !== "Ready") continue;
      const canonicalHref = entry.target.kind === "daily_date" && facts?.ref.startsWith("page:") ? `/pages/${facts.ref.slice(5)}` : entry.href;
      const value = recentValueForHref(canonicalHref, normalizeVisitTitleHint(presentation.title));
      if (!value) continue;
      value.detail_hint = normalizeVisitTitleHint(presentation.detail);
      if (recentTargetKey(value.target) !== recentTargetKey(entry.target) || value.href !== entry.href || value.title_hint !== entry.title_hint || value.detail_hint !== entry.detail_hint)
        recent.reconcile({ target: entry.target, expected_used_revision: entry.used_revision, replacement: value });
    }
  }, [recent, forRecent, local.entries, state.panes, remote, isRecentRemoved]);
  const retryTitles = useCallback(() => retry(value => value + 1), []);
  const value = useMemo(() => ({ forVisit, forRecent, isRecentRemoved, holdRecent, resourceRefForVisit, retryTitles }), [forVisit, forRecent, isRecentRemoved, holdRecent, resourceRefForVisit, retryTitles]);
  useEffect(() => {
    for (const pane of state.panes) {
      const visit = pane.current_visit; const route = resolvePaneRouteModel(visit.href);
      if (!route.titleKey) continue;
      const presentation = forVisit(visit);
      if (presentation.status === "Ready") setVisitTitleHint({ paneId: pane.id, visitId: visit.id, titleKey: route.titleKey, title: presentation.title });
    }
  }, [state.panes, forVisit, setVisitTitleHint]);
  return <PublisherContext value={publishLocal}><Context value={value}>
    {locators.map(locator => {
      if (!authored(locator) || locator.kind !== "daily_date" && locator.kind !== "resource_ref") return null;
      const key = panePresentationLocatorKey(locator);
      return <AuthoredTitleSubscription key={key} store={store} locatorKey={key}
        kind={locator.kind === "daily_date" ? "daily" : "resource"}
        value={locator.kind === "daily_date" ? locator.local_date : locator.ref} usedRevision={[...recent.snapshot?.entries ?? [], ...heldRecent].find(entry => recentTargetKey(entry.target) === key)?.used_revision} publish={publishLocal} />;
    })}
    {children}
  </Context></PublisherContext>;
}
export function useWorkspacePresentations(): Presentations { const value = useContext(Context); if (!value) throw new Error("workspace presentations require their account provider"); return value; }
