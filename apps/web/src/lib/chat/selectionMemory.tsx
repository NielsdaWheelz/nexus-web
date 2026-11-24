"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch } from "@/lib/api/client";

import { changeStamp, useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue, type ReadDescriptor, type ServerValue } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { catalogReadPolicy, readCatalog } from "./catalog";
import { getLibrarianCommands } from "./commands";
import type { SelectionEditor } from "./selection";
import type { Catalog } from "./wire";

type Memory = ApiJson<"/me/chat-selection", "get">["data"];
type Context = {
  read: ServerValue<Memory>;
  catalog: ReadDescriptor<Catalog>;
  enter(): void;
  fresh(catalog: Catalog | null): SelectionEditor | null;
};
const ChatSelectionContext = createContext<Context | null>(null);

export function ChatSelectionProvider({ children }: { children: ReactNode }) {
  const changes = useChangeStamp("ChatSelection");
  const foreground = useRefreshStamp(true, 0);
  const { accountId } = useAuthenticatedAccount();
  const owner = useMemo(() => getLibrarianCommands(accountId), [accountId]);
  const revision = useSyncExternalStore(owner.subscribe, owner.getCatalogRevision, () => 0);
  const catalog = useMemo(() => ({ key: "/llm-catalog", stale: `${foreground}/${revision}`, load: readCatalog, ...catalogReadPolicy }), [foreground, revision]);
  const [entry, setEntry] = useState(0);
  const fence = useRef(0);
  const stale = `${changes}:${foreground}:${entry}`;
  const read = usePaneFreeServerValue({ key: "/me/chat-selection", stale, load: async signal =>
    (await apiFetch<ApiJson<"/me/chat-selection", "get">>("/api/me/chat-selection", { cache: "no-store", signal })).data });
  const enter = useCallback(() => { fence.current += 1; setEntry(value => value + 1); }, []);
  const fresh = useCallback((catalog: Catalog | null): SelectionEditor | null => {
    if (fence.current !== entry || changeStamp("ChatSelection") !== changes || read.status !== "ready" || !read.fresh || read.refreshing || read.error) return null;
    const remembered = read.data.last_used;
    if (remembered) return { kind: "Selected", route: remembered.route, selection: remembered.selection };
    return catalog ? { kind: "Selected", route: { kind: "CodexPersonal" }, selection: catalog.chat_seed.selection } : null;
  }, [changes, entry, read]);
  const value = useMemo(() => ({ read, catalog, enter, fresh }), [read, catalog, enter, fresh]);
  return <ChatSelectionContext value={value}>{children}</ChatSelectionContext>;
}

export function useChatSelection() {
  const value = useContext(ChatSelectionContext);
  if (!value) throw new Error("chat selection provider missing");
  return value;
}
