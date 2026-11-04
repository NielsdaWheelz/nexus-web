"use client";

import {createContext} from "react";
import type {ExcerptView} from "@nexus/authored/excerpt";
import type {ResourceProjection} from "@nexus/authored/types";

/** One reader snapshot's display dependencies. A null entry is absent locally,
 * not permission to read an authored target from the server. */
export interface PreparedResource {
  readonly resource: ResourceProjection;
  /** null: only the projection was requested. A completed full read keeps its capture. */
  readonly full: { readonly captureRevision: string | null; readonly excerpt: ExcerptView | null } | null;
}
export type PreparedResources = ReadonlyMap<string, PreparedResource | null>;
export const PreparedResourcesContext = createContext<PreparedResources | null>(null);
