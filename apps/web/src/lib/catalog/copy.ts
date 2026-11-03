/** Catalog availability is a modeled local outcome, never a remote deletion. Its codes are a
 * domain ahead of transport: `E_CATALOG_INCOMPATIBLE`, `_IO` and `_INVALID` are status-0 failures
 * that `transportOf` would read as `Offline` or `Unavailable`, so a reader that may meet them asks
 * here first. */
import type { Line } from "@/components/feedback/stage";

type CatalogCode = "E_CATALOG_COVERAGE" | "E_CATALOG_UNAVAILABLE" | "E_CATALOG_INVALID" | "E_CATALOG_INCOMPATIBLE" | "E_CATALOG_IO" | "E_CATALOG_TOO_LARGE";

const CATALOG_LINES: Readonly<Record<CatalogCode, Line>> = {
  E_CATALOG_COVERAGE: { fact: "not in the saved catalog." },
  E_CATALOG_UNAVAILABLE: { fact: "catalog not ready on this device.", reason: "connect to save your lists for offline browsing." },
  E_CATALOG_INVALID: { fact: "saved catalog couldn’t be opened.", reason: "connect and save your catalog again." },
  E_CATALOG_INCOMPATIBLE: { fact: "saved catalog needs an online rebuild.", reason: "connect and save your catalog again." },
  E_CATALOG_IO: { fact: "saved catalog couldn’t be read.", reason: "connect and save your catalog again." },
  E_CATALOG_TOO_LARGE: { fact: "catalog is too large to save.", reason: "the saved catalog was not replaced." },
};

/** A catalog code's line; null for any other code. */
export function catalogLine(error: { readonly code: string }): Line | null {
  return Object.hasOwn(CATALOG_LINES, error.code) ? CATALOG_LINES[error.code as CatalogCode] : null;
}
