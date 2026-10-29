"use client";
/** Authored titles come from the local graph, even online. Other resource labels
 * retain their server/catalog owner. Saved visit hints are display evidence only. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api/client";
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
import type { PaneVisit } from "@/lib/workspace/model";
import { useWorkspaceStore } from "@/lib/workspace/store";
import type { AuthoredStore, ResourceProjection } from "@nexus/authored/types";
type Canonical = Schema<"WorkspacePresentationOut">;
interface TitleFacts { ref: string; title: string; local_date: string | null }
export const PANE_TITLES_FAILED = "couldn’t refresh pane titles.";
export interface PanePresentation { title: string; name:string|null; detail: string | null; status: "Ready" | "Unsaved" | "Loading" | "Unresolved" | "Unavailable" | "Failed" }
interface Presentations { forVisit(visit: PaneVisit): PanePresentation; resourceRefForVisit(visit: PaneVisit): string | null; retryTitles(): void }
const Context = createContext<Presentations | null>(null);
type PublishTitle = (key: string, facts: TitleFacts | null, storeRevision: string) => void;
function titleFacts(resource: ResourceProjection | null): TitleFacts | null {
  return resource ? {ref: resource.ref, title: resource.title ?? resource.body_text?.split("\n")[0] ?? resource.selection?.quote_exact ?? "", local_date: resource.local_date} : null;
}
function authored(locator: PanePresentationLocator): boolean { return locator.kind === "daily_date" || locator.kind === "resource_ref" && /^(page|note_block|highlight):/u.test(locator.ref); }
/** One locator owns one bounded read; sibling pane changes do not restart it. */
function AuthoredTitleSubscription({ store, locatorKey, kind, value, publish }: {
  store: AuthoredStore; locatorKey: string; kind: "daily" | "resource"; value: string;
  publish: PublishTitle;
}) {
  useEffect(() => store.subscribe(kind === "daily" ? { kind: "daily", local_date: value } : { kind: "resource", ref: value }, result => {
    publish(locatorKey, titleFacts(result.rows[0]?.resource ?? null), result.store_revision);
  }, reportError), [store, locatorKey, kind, value, publish]);
  return null;
}
export function WorkspacePresentationsProvider({ accountId, children }: { accountId: string; children: ReactNode }) {
  const { state, setVisitTitleHint } = useWorkspaceStore();
  const store = useAuthoredStore();
  const catalog = useCatalogState().data;
  const changes = useChangeStamp("Libraries", "Entries", "Metadata", "Podcasts", "Chats");
  const { observation } = useImports();
  const foreground = useRefreshStamp(true, 0);
  const [attempt, retry] = useState(0);
  const locators = useMemo(() => {
    const result = new Map<string, PanePresentationLocator>();
    for (const pane of state.panes) { const locator = resolvePaneRouteModel(pane.current_visit.href).titleLocator; if (locator) result.set(panePresentationLocatorKey(locator), locator); }
    return [...result.values()];
  }, [state.panes]);
  const [local, setLocal] = useState<{entries: Map<string, {facts: TitleFacts | null; store_revision: string}>; semanticRevision: number}>(() => ({entries: new Map(), semanticRevision: 0}));
  const publishLocal = useCallback<PublishTitle>((key, facts, storeRevision) => {
    setLocal(previous => {
      const before = previous.entries.get(key);
      const order = before ? BigInt(storeRevision) - BigInt(before.store_revision) : null;
      if (order !== null && order < 0n) return previous;
      const old = before?.facts;
      const unchanged = old === facts || old !== undefined && old !== null && facts !== null && old.ref === facts.ref && old.title === facts.title && old.local_date === facts.local_date;
      if (order === 0n && unchanged) return previous;
      // justify-service-invariant-check: one account revision has one canonical caption per locator.
      if (order === 0n) throw new Error("title facts disagree at the same store revision");
      return {entries: new Map(previous.entries).set(key, {facts, store_revision: storeRevision}), semanticRevision: previous.semanticRevision + (unchanged ? 0 : 1)};
    });
  }, []);
  const remoteLocators = locators.filter(locator => !authored(locator));
  const remoteKey = JSON.stringify([accountId, remoteLocators, changes, observation, foreground, attempt]);
  const remote = usePaneFreeServerValue({ key: `workspace-presentations:${remoteKey}`, stale: "", load: async signal => {
    const items: ApiJson<"/me/workspace-presentations", "post">["data"]["items"] = [];
    for (let offset = 0; offset < remoteLocators.length; offset += 100) {
      const result = await apiFetch<ApiJson<"/me/workspace-presentations", "post">>("/api/me/workspace-presentations", { method: "POST", body: JSON.stringify({ locators: remoteLocators.slice(offset, offset + 100) }), signal });
      items.push(...result.data.items);
    }
    return new Map(items.map(item => [panePresentationLocatorKey(item.locator), item.presentation]));
  } });
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
      if (resource === null) return { title: route.id === "dailyDate" ? route.defaultLabel : visit.title_hint ?? `unavailable ${kind}`, name:route.id === "dailyDate"?route.defaultLabel:visit.title_hint, detail: route.id === "dailyDate" ? "page" : "removed", status: route.id === "dailyDate" ? "Ready" : "Unavailable" };
      const title = resource.title;
      const name = title.trim() ? title : resource.local_date !== null ? route.defaultLabel : null;
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
  const retryTitles = useCallback(() => retry(value => value + 1), []);
  const value = useMemo(() => ({ forVisit, resourceRefForVisit, retryTitles }), [forVisit, resourceRefForVisit, retryTitles]);
  useEffect(() => {
    for (const pane of state.panes) {
      const visit = pane.current_visit; const route = resolvePaneRouteModel(visit.href);
      if (!route.titleKey) continue;
      const presentation = forVisit(visit);
      if (presentation.status === "Ready") setVisitTitleHint({ paneId: pane.id, visitId: visit.id, titleKey: route.titleKey, title: presentation.title });
    }
  }, [state.panes, forVisit, setVisitTitleHint]);
  return <Context value={value}>
    {locators.map(locator => {
      if (!authored(locator) || locator.kind !== "daily_date" && locator.kind !== "resource_ref") return null;
      const key = panePresentationLocatorKey(locator);
      return <AuthoredTitleSubscription key={key} store={store} locatorKey={key}
        kind={locator.kind === "daily_date" ? "daily" : "resource"}
        value={locator.kind === "daily_date" ? locator.local_date : locator.ref} publish={publishLocal} />;
    })}
    {children}
  </Context>;
}
export function useWorkspacePresentations(): Presentations { const value = useContext(Context); if (!value) throw new Error("workspace presentations require their account provider"); return value; }
