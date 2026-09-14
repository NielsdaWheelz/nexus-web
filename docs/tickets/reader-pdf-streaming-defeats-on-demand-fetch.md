# pdf streaming undermines the requested on-demand fetch policy

- status: open; production/native transport qualification remains
- origin: 2026-09-13 workspace architecture review; checkout `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: pdf reader / browser bandwidth and memory

## evidence

`apps/web/src/components/PdfReader.tsx:1784-1790` combines
`disableAutoFetch: true` with `disableStream: false`. the installed pdf.js
contract at `apps/web/node_modules/pdfjs-dist/types/src/display/api.d.ts:194-202`
states that disabling prefetch also requires disabling streaming. the current
configuration therefore does not establish on-demand byte loading.
the current [pdf.js api documentation](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)
states the same requirement.

hosted pdf bytes use a signed object-store url
(`python/nexus/services/media_file_access.py:98-141`), so this is a browser
bandwidth/residency hazard, not evidence that pdf downloading killed the api.
the flag and initial-task ownership fixes pass the actual browser HTTP experiment
`35d417c7413b4d3e`. opening the 100 mib source transfers 1,179,648 bytes through
idle; distant navigation and complete find remain correct. non-range fallback
reads the complete source. original-base sensitivity `84c8e5f59059e728` at
`eafa104039` reaches the eager-transfer assertion, then passes on the candidate.
an additional distant-page failure replaced eight-frame polling with the
existing viewer's page-render signal.

these fixtures establish browser byte demand, not production object-store or
Android WebView transport. complete-find native memory and worker reclamation
remain under [oi-169](pdf-complete-find-native-memory-qualification.md).

## prerequisites and fix

choose the deliberate pdf loading policy using representative hosted and native
documents. if demand loading is required, configure streaming consistently and
prove range delivery through the actual transports. preserve pdf.js recovery,
find, page navigation, selection, and signed-url renewal. document that pdf
structure and whole-document find may legitimately require additional data.

## acceptance

through `./scripts/test`, measure bytes and browser memory when opening one page
of a large range-capable pdf, idling, moving to a distant page, and running find.
show the selected loading policy holds with hosted and native delivery; handle
non-range sources explicitly and preserve complete reading.
