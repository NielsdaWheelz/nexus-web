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
import type { AuthoredQuery, ResourceProjection } from "@nexus/authored/types";
type Canonical = Schema<"WorkspacePresentationOut">;
export const PANE_TITLES_FAILED = "couldn’t refresh pane titles.";
export interface PanePresentation { title: string; name:string|null; detail: string | null; status: "Ready" | "Unsaved" | "Loading" | "Unresolved" | "Unavailable" | "Failed" }
interface Presentations { forVisit(visit: PaneVisit): PanePresentation; resourceRefForVisit(visit: PaneVisit): string | null; retryTitles(): void }
const Context = createContext<Presentations | null>(null);
function authored(locator: PanePresentationLocator): boolean { return locator.kind === "daily_date" || locator.kind === "resource_ref" && /^(page|note_block|highlight):/u.test(locator.ref); }
function authoredQuery(locator: PanePresentationLocator): AuthoredQuery {
  if (locator.kind === "daily_date") return { kind: "daily", local_date: locator.local_date };
  if (locator.kind !== "resource_ref") throw new Error("authored title locator missing");
  return { kind: "resource", ref: locator.ref };
}
function projectTitle(resource: ResourceProjection): string { return resource.title ?? resource.body_text?.split("\n")[0] ?? resource.selection?.quote_exact ?? ""; }
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
  const signature = JSON.stringify(locators);
  const [local, setLocal] = useState<Map<string, ResourceProjection | null>>(new Map());
  useEffect(() => {
    const subscriptions = locators.filter(authored).map(locator => store.subscribe(authoredQuery(locator), result => {
      setLocal(previous => new Map(previous).set(panePresentationLocatorKey(locator), result.rows[0]?.resource ?? null));
    }));
    return () => { for (const unsubscribe of subscriptions) unsubscribe(); };
  }, [store, signature]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const forVisit = useCallback((visit: PaneVisit): PanePresentation => {
    const route = resolvePaneRouteModel(visit.href);
    if (route.labelMode === "static") return { title: route.defaultLabel, name:route.defaultLabel, detail: null, status: "Ready" };
    const locator = route.titleLocator;
    const kind = route.id === "dailyDate" ? "page" : route.defaultLabel.toLowerCase();
    if (!locator) return { title: visit.title_hint ?? kind, name:visit.title_hint, detail: "unavailable", status: "Unavailable" };
    const key = panePresentationLocatorKey(locator);
    if (authored(locator)) {
      const resource = local.get(key);
      if (resource === undefined) return { title: visit.title_hint ?? kind, name:visit.title_hint, detail: "loading title…", status: "Loading" };
      if (resource === null) return { title: route.id === "dailyDate" ? route.defaultLabel : visit.title_hint ?? `unavailable ${kind}`, name:route.id === "dailyDate"?route.defaultLabel:visit.title_hint, detail: route.id === "dailyDate" ? "page" : "removed", status: route.id === "dailyDate" ? "Ready" : "Unavailable" };
      const title = projectTitle(resource);
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
    if (remote.status === "failed" || (remote.status === "ready" && remote.error)) return { title, name, detail: "couldn’t refresh title", status: "Failed" };
    if (remote.status !== "ready") return { title, name, detail: "loading title…", status: "Loading" };
    return { title, name, detail: "removed or no longer accessible", status: "Unavailable" };
  }, [local, remoteFacts, remote, catalog]);
  const resourceRefForVisit = useCallback((visit: PaneVisit) => {
    const locator = resolvePaneRouteModel(visit.href).titleLocator;
    if (!locator) return null;
    const key = panePresentationLocatorKey(locator);
    return local.get(key)?.ref ?? remoteFacts?.get(key)?.resource_ref ?? (locator.kind === "resource_ref" ? locator.ref : null);
  }, [local, remoteFacts]);
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
  return <Context value={value}>{children}</Context>;
}
export function useWorkspacePresentations(): Presentations { const value = useContext(Context); if (!value) throw new Error("workspace presentations require their account provider"); return value; }
