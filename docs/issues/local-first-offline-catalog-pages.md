# offline catalog page summaries must leave every client

the server catalog no longer carries pages (`OfflineCatalogOut.notes` removed);
the local authored store is their sole owner. client readers of the old section
remain: `apps/web/src/lib/catalog/selectors.ts` (`notes` map, `catalogPage`, the
updated/title page list) and their callers.

impact: the web build fails against the regenerated wire until those readers go;
any surviving page list would duplicate local authored results.

resolved when no client reads catalog pages and installed clients list pages
only from the local store in title order.
