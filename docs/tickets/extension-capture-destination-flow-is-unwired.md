# extension capture has no destination flow

status: open · origin: 2026-09-23 firefox v1 review · area: extension / libraries

`apps/extension/popup.html:10-19` exposes base url, connect, capture and forget
token, with no library selection. `popup.js:283-287` refuses disconnected
capture rather than continuing through login. article, file and url endpoints
already accept selected destinations (`python/nexus/api/routes/media_ingest.py:71-149`),
but `python/nexus/auth/middleware.py:47-52` authorizes extension tokens only for
capture and revocation, so the ordinary writable-destination read is unavailable.

prerequisite: preserve the existing intake contract: all is implicit; selected
ids are additional writable non-default libraries (docs/modules/sharing.md:56).

fix: compose login, source review and the shared controlled library chooser in
one capture flow. provide the narrowly scoped destination read through the
existing governance owner; send selected ids on initial acceptance.
the user's v1 also needs a link-context menu for pdf/epub download links. it
must preserve the clicked link separately from its source page and open this
same form; the current manifest/popup has no menu entry or link-target intake.

acceptance: signed-out capture returns to its original source after normal web
login; signed-in capture can save to all alone or multiple writable libraries;
unwritable destinations are unavailable and rejected server-side.
right-clicking an epub link saves that book, not its parent web page.
