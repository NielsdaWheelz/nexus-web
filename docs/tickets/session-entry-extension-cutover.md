# extension capture contract cutover

status: deferred by user; production capture decoder unqualified
origin: 2026-10-14 session-entry release review; pr #610
area: extension / release compatibility

the api returns `import_ref` on all three upload outcomes
(`python/nexus/schemas/media.py:387–441`). pre-610 builds reject the extra field;
current builds require it (`apps/web/src/extension/uploadSessionContract.ts:154–243`).
login uses a different decoder. the earlier imports firefox proof used isolated
dev services, so it does not establish production capture compatibility.

scope decision: the user explicitly deferred production capture proof. no new
capture, source, model or brave work was admitted. this is not a passing capture
result. [final production qualification](../session-entry-experience-plan.md#production-qualification)
records exact `0bd6619236` temporary installation, matching payloads and actual
toolbar retained-session validation. the ordinary `3839` sign-in remains historical
evidence on byte-identical payloads. temporary activation ended with normal browser
close; [persistent signed distribution](extension-firefox-distribution-consent-is-undeclared.md)
remains separate.

at `2026-10-15T00:34:30.842755Z`, one controller-owned repeatable-read, read-only
transaction found zero `BrowserCapture` upload sessions for viewer
`59e51903-ccb8-40f5-a915-a75d7476e3b2`. it selected only capture id, derived
outcome, kind, media id and byte hash. exact query/result:
`/tmp/nexus-session-entry-release-20261014/production-support/existing-browser-captures.json`.

there is no public command to read an arbitrary capture handle. popup `resume`
requires a genuine persisted frozen draft (`apps/web/src/extension/background.ts:253,1018`);
only its handle reaches the status get and strict decoder in
`apps/web/src/extension/captureClient.ts:189`. popup opening reads session identity.
hidden storage seeding or detached decoding is not installed-consumer proof.

a new text-pdf capture creates source work and requests metadata
(`python/nexus/services/pdf_lifecycle.py:118`). source completion queues indexing
and bibliography research (`python/nexus/services/media_source_ingest.py:2264–2285`),
including provider work; no public save option suppresses those jobs.

update (ingest reauthor, uploads/capture/share page): `uploadSessionContract.ts`
and `captureClient.ts` are gone. the extension reads the generated wire without a
strict decoder of its own, upload and capture answers carry `import_ref` beside the
client's `session_id`, and web, api and the signed extension ship from one sha
([release](../issues/release-ingest.md)). the production capture proof below is
still deferred and now concerns that extension.

prerequisite: explicit admission of a later ordinary capture and its downstream
work; use the matching production-origin artifact without compatibility code.
acceptance: record source, artifact hash, manifest id/version and installation
mode; observe the actual installed consumer decode a genuine production capture
response with `import_ref`, then record media/import and downstream outcomes.
auth-only evidence cannot close this item. any deduplication claim must prove
same-viewer/kind browser-byte identity and media/source-attempt reuse; same url
or a prior local-file upload is insufficient
(`python/nexus/services/media_upload_sessions.py:625–694,805–826`).
