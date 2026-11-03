# import failure catalog states causes its codes do not prove

source: frozen `a7dcd48986dcd09f2bd491564fbfae4398540fbe`; source-only.

problem and impact: the live imports detail composes failure reason plus explanation (`apps/web/src/components/imports/ImportInspector.tsx:246`) from `lib/imports/copy.ts`; several entries infer history or provider behavior beyond the actual raise. this is a causal defect, independent of long-job typography or case.

evidence (web paths under apps/web/src):
- copy.ts:159-161 says `Import changed`; python/nexus/services/source_runner.py:78-88 records E_RESOURCE_CONFLICT for a refresh that would remove referenced notes or lose note identities, not necessarily a concurrent change; reader_apparatus.py:814,1154 are the guards.
- copy.ts:200-202 says the source did not respond; safe_fetch.py:121-129,163,166-177 maps actual response statuses and redirect failures to E_SOURCE_FETCH_FAILED.
- copy.ts:93-95 says the source was still being processed; safe_fetch.py:159-175 also maps a fetch timeout to E_INGEST_TIMEOUT.
- copy.ts:149-151 says the podcast provider did not respond; podcasts/provider.py:21-26 emits E_PODCAST_PROVIDER_UNAVAILABLE before any call if credentials are absent.
- copy.ts:248-250 claims audio was reached; podcasts/deepgram_adapter.py:62-75 maps HTTP and parsing failures without proving the remote provider fetched the audio.
- copy.ts:298-300 claims another capture changed this source; x_ingest.py:492-494 emits E_X_SOURCE_CONFLICT for cyclic provider references.
- copy.ts:324-326 says x did not respond; x_client.py:245,253,273 also emits E_X_PROVIDER_UNAVAILABLE for malformed or contradictory returned data.

proposed exact words, keeping current server-owned recovery offers: conflict `couldn’t update this import.`; source fetch `couldn’t fetch this source.`; ingest timeout `this import took too long.`; podcast provider `the podcast source isn’t available.`; transcription `couldn’t transcribe this recording.`; x source conflict `couldn’t refresh from x.`; x provider `x imports aren’t available.`. omit each unsupported explanation. all are under14 words. retain saved-copy claims only in the existing item.can_read-gated owner, not code-only records.

resolution proof: each demonstrated alternate raise produces the cause-free line; detail/row/history use the same corrected record and existing actual recovery offers. no backend or wire change is needed.

ordinary history labels and other long-job wording are outside this correction.
