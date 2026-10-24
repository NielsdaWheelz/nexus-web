/** Read provenance belongs to the displayed value, independently of admission. */
export type CatalogSource = { readonly kind: "catalog"; readonly snapshot_id: string; readonly captured_at: string };
export type ReadSource = { readonly kind: "live" } | CatalogSource;
export const LIVE_SOURCE: ReadSource = { kind: "live" };
export interface CatalogValue<T> { readonly data: T; readonly source: CatalogSource }
/** Null means no saved catalog; a missing covered identity is a modeled coverage error. */
export interface CatalogRead<T> {
  readonly snapshot_id: string | null;
  load(signal: AbortSignal): Promise<CatalogValue<T> | null>;
}
