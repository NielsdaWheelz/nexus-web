import {createContext} from "react";
import type {ApiError} from "@/lib/api/client";
import type {queryConnections} from "./links";

export function remoteConnectionScope(ownerRef: string) {
  return {
    refs: [ownerRef], direction: "both", rollup: "owner",
    filters: {origins: ["citation", "discovery", "assistant", "document_embed"]},
  } satisfies Omit<Parameters<typeof queryConnections>[0], "match_text">;
}

export interface OpenOutlineScope {
  ref: string;
  label: string;
  owner: string | null;
  parent: string | null;
  entering: string | null;
  excluded: readonly string[];
}

export type OutlineScopeResult =
  | {kind: "ready"; ids: ReadonlySet<string>}
  | {kind: "failed"; error: ApiError};

export const OpenOutlineScopes = createContext<{
  filter: string;
  results: ReadonlyMap<string, OutlineScopeResult> | null;
  remember(key: string, scope: OpenOutlineScope): void;
  close(key: string): void;
  retry(key: string): void;
} | null>(null);

export const ParentOutlineScope = createContext<string | null>(null);
