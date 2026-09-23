# document routing relies on suffixes and a head request

status: open · origin: 2026-09-23 firefox v1 review · area: extension files

`apps/extension/popup.js:255-276` recognizes document suffixes, otherwise attempts
article capture and then head-based type discovery. a failed/unsupported head
leaves url capture as the route even when get would return a pdf/epub. file
capture also substitutes a guessed content type (`:215-223`) when the response
is actually html, delaying identification of login/landing-page responses until
backend signature validation. source-confirmed; no live download was attempted.

fix: treat url suffixes as hints and use the bounded get response's type,
disposition and validated bytes to select document capture. retain the selected
link separately from its parent page. report login/unsupported html accurately;
never substitute the parent article or silently change source after submission.

acceptance: extensionless/signed pdf and epub links work without head support;
redirects and content-disposition filenames are handled; an html login page is
not presented as a successfully saved book.
