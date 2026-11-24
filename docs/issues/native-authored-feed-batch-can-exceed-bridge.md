# split large native authored feed pages at durable cursors

`apps/web/src/lib/authored/native.ts` reads the touched states and passes all
changes and their merged states to one `apply_remote` bridge call per feed
page. at d50d0af60 the 16 mib assembly limit still applies to the whole
request, even when each change and canonical record fits by itself. rejected
input leaves `server_cursor` before the page, so the same page can block
catch-up. this was identified by source review. the paired rich-read fixture
provisions through the separate byte-bounded `stage` path.

resolve in a paired webview with an incoming page whose encoded merge exceeds
16 mib and whose individual changes fit. apply bounded prefixes at their
durable cursors, interrupt between prefixes, and verify exact resumption and
canonical state with local pending changes intact.
