# Walknotes — Playback Waypoints That Anchor to the Transcript Line You Were Hearing — Hard Cutover

**Status:** Spec · **Rev 1** · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims, no flags-for-old-behavior.

**Historical note (2026-07-16):** `lectern-player-lifecycle-hard-cutover.md`
deleted `GlobalPlayerQueuePanel`, the "pattern" this doc cites for
`WalknoteReviewPanel` below. Its cited `GlobalPlayerFooter.tsx` line numbers
for the queue/review button (e.g. "lines 510/694") have also drifted — the
shipped review button uses the `walknoteButton`/`walknoteBadge` CSS classes
(`GlobalPlayerFooter.module.css`), and, contrary to the "no separate badge
element" note below, the shipped markup does use a separate `walknoteBadge`
span. These are retained as historical implementation record only.

## One-line

One tap on the global player marks the current `(media_id, position_ms)` as a session waypoint; hold to speak a reaction; an explicit materialize step resolves each waypoint to the nearest transcript fragment, creates a real `highlight_fragment_anchors`-anchored highlight, and attaches the Deepgram-transcribed voice note as the highlight note body.

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** Podcast episodes have transcript fragments with timestamps. `insert_transcript_fragments` (`services/transcript_segments.py:93`) maps each `TranscriptSegmentInput` to a `fragments` row with `t_start_ms` and `t_end_ms` populated. This is the durable anchor; `podcast_transcript_segments` is an index-parallel copy for search. Fragment rows are returned by `GET /media/{id}/fragments` (`media.py:109`) ordered by `t_start_ms ASC NULLS LAST`.
- **P-2.** The sole highlight writer for reflowable content is `create_highlight_for_fragment(db, viewer_id, fragment_id, req: CreateHighlightRequest)` (`services/highlights.py:328`). The BFF route is `POST /api/fragments/{fragmentId}/highlights`. No other path creates fragment highlights.
- **P-3.** Highlight notes are attached via `PUT /api/highlights/{highlightId}/note` → FastAPI `PUT /highlights/{highlight_id}/note` → `notes_service.set_highlight_note_body_pm_json`. Body is a ProseMirror paragraph node: `{"type": "paragraph", "content": [{"type": "text", "text": "..."}]}`. Client function: `saveHighlightNote` (`lib/highlights/api.ts:158`).
- **P-4.** `DeepgramClient` (`services/podcasts/deepgram_adapter.py`) currently accepts only an audio URL. For short voice recordings (MediaRecorder blobs), a new `transcribe_raw_audio(bytes, content_type)` path must be added alongside the existing URL path — not replacing it.
- **P-5.** `Permissions-Policy: microphone=()` in `lib/security/headers.ts:39` currently blocks all microphone access. Voice note recording requires this to become `microphone=(self)`. This is a deliberate security-policy change; call it out explicitly in every review.
- **P-6.** `can_transcribe` entitlement (`services/billing_entitlements.py:70`) gates Deepgram access. Voice note transcription uses the same gate.

---

## 1. Problem (grounded diagnosis)

### 1.1 The idea arrives at the ear, the note arrives on a bench

The best moment to respond to an argument is when it lands — mid-episode, while walking. Today that moment is lost. The reader's highlight flow requires the episode to be open in the foreground, a text selection to be made, and a composer to be engaged. None of that is available with a phone in a pocket.

### 1.2 The anchor story is the hard problem

The naive approach — "save the timestamp, link to the episode page" — produces a shallow timestamp link, not a real knowledge graph edge. The existing `highlight_fragment_anchors` system produces real anchors with `exact` + `prefix` + `suffix` quote triples, tied to `fragment_id` + codepoint offsets. Walknotes must produce the same kind.

The path is real: every podcast transcript fragment carries `t_start_ms` and `t_end_ms` (`db/models.py:1784-1785`). `resolveActiveTranscriptFragment` in `lib/media/transcriptView.ts:138` already implements nearest-match lookup (`findNearestTranscriptFragmentByStartMs` at `:108`). Materializing `(media_id, position_ms)` into a `highlight_fragment_anchors` row is a two-step client operation: fetch fragments, find nearest, `POST /api/fragments/{id}/highlights` with `start_offset=0, end_offset=len(canonical_text)`. This creates a whole-fragment highlight — an honest anchor with the full segment text as `exact`.

### 1.3 Voice notes through Deepgram

`DeepgramClient.transcribe(audio_url)` sends a JSON body `{"url": audio_url}` to `POST /v1/listen`. Browser-recorded audio (MediaRecorder, `audio/webm;codecs=opus`) cannot be pointed to by a URL the server can access without R2 staging. The spec adds `transcribe_raw_audio(audio_bytes, content_type)` to `DeepgramClient`: same endpoint, binary body, `Content-Type` from the recording format. No R2 staging, no presigned URL dance.

### 1.4 Permissions-Policy blocks microphone today

`PERMISSIONS_POLICY` in `lib/security/headers.ts` includes `"microphone=()"` (line 39). Voice recording is a deliberate capability that must be granted to `self` and re-reviewed in any CSP audit.

### 1.5 YouTube is not in scope

YouTube fragments also carry timestamps (`youtube_transcripts.py`), but YouTube playback wraps an iframe and the player does not surface a seekable `currentTimeSeconds` in the same contract. Deferred with a single pointer: add YouTube support when the player module exposes a unified position contract across both backends.

---

## 2. Target behavior (user-facing)

- **Walk mode tap.** While an episode plays, a "Mark" button appears on `GlobalPlayerFooter`. Single tap: captures `{media_id, position_ms, recorded_at}` into the session list. Zero latency, no network call.
- **Hold to speak.** Hold the "Mark" button: the button transitions to a red recording indicator. Release: MediaRecorder stops, audio is POSTed to the BFF for transcription, the waypoint entry updates with the transcript text when it arrives (or "Failed to transcribe" if it errors).
- **Session list.** The footer shows a review button with the running waypoint count embedded in its `aria-label`. Tapping it opens the Walknote Review panel (a `MobileSheet`/overlay, like the queue panel).
- **Explicit materialize.** The review panel lists all waypoints: formatted timestamp, transcript text (or silence marker), keep/discard toggle. "Materialize" button resolves kept waypoints into real fragment highlights + attached note bodies and clears the session.
- **After materialize.** The episode's existing Highlights lens in the document map shows the new highlights. No new lens is needed. The highlights are standard `highlight_fragment_anchors` rows indistinguishable from manually created highlights.
- **Entitlement gate.** If `can_transcribe` is false, voice recording is disabled (button shows tap-only). The materialize path for tap-only waypoints (no voice text) still works; the highlight note body is omitted.

---

## 3. Goals / Non-goals

### Goals

- **G1.** Tap-to-mark on `GlobalPlayerFooter` for any playing podcast episode; client-side session state, zero-latency.
- **G2.** Hold-to-speak voice recording via MediaRecorder, gated by `can_transcribe` entitlement and `microphone=(self)` policy.
- **G3.** Deepgram `transcribe_raw_audio` path for voice blobs; no R2 staging.
- **G4.** Explicit materialize: `useWalknoteSession` hook resolves `position_ms → fragment → highlight → note` on user confirmation, using existing `createHighlight` + `saveHighlightNote` client calls.
- **G5.** All created highlights are standard `highlight_fragment_anchors` rows; no new table, no new `resource_edges.origin` kind.

### Non-goals

- **N1.** YouTube support. Explicit non-goal. One-line pointer: gated on unified player position contract.
- **N2.** Daily-note machine line. Out of scope; dawn-write spec (#4) owns that territory.
- **N3.** New document map lens. Walknote highlights appear in the existing `highlights` lens.
- **N4.** Durable backend staging of pre-materialize waypoints. Client-side sessionStorage only; closing the tab before materializing loses pending waypoints. Accepted trade-off for simplicity.
- **N5.** Background job for materialize. Materialize is synchronous in the browser; no new `background_jobs` kind, no `WORKER_ALLOWED_JOB_KINDS` change.
- **N6.** Audio archiving. Voice audio bytes are ephemeral; only the Deepgram transcript text is persisted.

---

## 4. Architecture and final state

### 4.1 Client session model

`lib/walknotes/walknoteSession.ts` owns `WalknoteWaypoint` and `useWalknoteSession`:

```
WalknoteWaypoint {
  id: string            // crypto.randomUUID()
  media_id: string
  position_ms: number
  recorded_at: string   // ISO timestamp
  voice_text: string | null      // transcription result; null = tap-only
  voice_status: 'idle' | 'recording' | 'transcribing' | 'done' | 'failed'
}
```

State lives in React context (sessionStorage-backed for minor refresh survival, cleared on session end). No server persistence before materialize.

### 4.2 Backend new endpoint

`POST /walknotes/transcribe-audio` (`api/routes/walknotes.py`, new):
- Auth: viewer required.
- Entitlement: `can_transcribe` checked before doing anything; returns `ApiError(E_PODCAST_QUOTA_EXCEEDED)` (HTTP 429) if false.
- Body: multipart/form-data with one `audio` field (binary), `content_type` field (string, e.g. `"audio/webm;codecs=opus"`), `max_duration_seconds` field.
- Size gate: reject bodies over 10 MB (≈ 2 minutes of Opus at 640 kbps — conservative ceiling).
- Calls `get_deepgram_client().transcribe_raw_audio(audio_bytes, content_type)`.
- On success (`result.status == 'completed'`), assembles the transcript string as `' '.join(seg['text'] for seg in result.segments)` and `duration_ms` as the last segment's `t_end_ms` (or `null` if segments is empty). On failure, raises `ApiError` using `result.error_code` (`TranscriptionResult` has no `transcript` field; the join step is mandatory).
- Returns `{"transcript": "...", "duration_ms": int | null}` or typed `ApiError`.

`DeepgramClient.transcribe_raw_audio(audio_bytes: bytes, content_type: str) -> TranscriptionResult` added to `services/podcasts/deepgram_adapter.py`:
- Posts raw bytes as body to `/v1/listen` with `Content-Type: {content_type}`.
- Same query params as the URL path (`smart_format`, `punctuate`, `language`); no diarization for short clips.
- Same timeout and error mapping as `_transcribe_with_deepgram`.
- No fixture path for raw audio in test mode (raw-audio transcription requires a real Deepgram key; tests mock the adapter).

BFF: `POST /api/walknotes/transcribe` (`apps/web/src/app/api/walknotes/transcribe/route.ts`) proxies multipart body to FastAPI.

### 4.3 Materialize flow (client, no new backend)

1. `useWalknoteSession.materialize(keptIds)` is called on user confirmation.
2. For each kept waypoint (sequentially to avoid race on fragment lock):
   a. Fetch media fragments: `GET /api/media/{media_id}/fragments` (cached by media_id across waypoints for the same episode).
   b. `resolveActiveTranscriptFragment(fragments, { requestedStartMs: position_ms })` — reuses existing logic from `lib/media/transcriptView.ts:138`.
   c. `createHighlight(fragment.id, 0, fragment.canonical_text.length, "yellow")` → `POST /api/fragments/{id}/highlights`.
   d. If `voice_text !== null`: `saveHighlightNote(highlight.id, null, crypto.randomUUID(), pm_doc_from_text(voice_text), crypto.randomUUID())` → `PUT /api/highlights/{id}/note`.
3. Session cleared. Panel shows `N highlights created`.

`pm_doc_from_text(text: string)` is a pure client-side helper (mirrors `note_bodies.pm_doc_from_text`):
```ts
{ type: "paragraph", content: [{ type: "text", text }] }
```

### 4.4 GlobalPlayerFooter additions

`GlobalPlayerFooter.tsx` gains:
- `useWalknoteSession()` consumption.
- A "Mark" button with `onPointerDown`/`onPointerUp` handlers distinguishing tap vs hold (hold threshold: 500 ms), placed per layout:
  - **Desktop (`controlsRow`):** appended after the Forward 30 button, before the seek area. Shown only when `track !== null`.
  - **Mobile minibar:** not shown (insufficient space; the expanded view is the affordance).
  - **Mobile expanded sheet (`expandedSecondary` row):** placed alongside Effects and Queue buttons.
- A review button with `aria-label={`Review waypoints (${waypointCount})`}` and an `aria-hidden` child span for the visual count (same pattern as the queue button at GlobalPlayerFooter.tsx lines 510/694). Opens `WalknoteReviewPanel`.
- A `role=status aria-live=polite` region (visually hidden when inactive) that announces state transitions: "Recording", "Transcribing", "Transcription failed", and "N highlights created" after materialize.

`WalknoteReviewPanel.tsx` (`components/walknotes/`) is a `MobileSheet`-based overlay (pattern: `GlobalPlayerQueuePanel`):
- Lists `WalknoteWaypoint[]` with timestamp, text, keep/discard toggle.
- "Materialize N" button calls `useWalknoteSession.materialize`.
- "Discard all" clears session without creating highlights.

`useVoiceRecorder.ts` (`lib/walknotes/`) encapsulates MediaRecorder lifecycle: request permission, start, stop, return `Blob`. Audio duration cap enforced by a `setTimeout` auto-stop at `MAX_VOICE_NOTE_DURATION_MS = 120_000`.

### 4.5 Permissions-Policy

`lib/security/headers.ts` line 39: `"microphone=()"` → `"microphone=(self)"`. This is the only security-policy change in this cutover.

---

## 5. Data model / migration

No new tables. No migration required.

All created artefacts use existing tables:
- `highlights` — created by the existing highlight writer.
- `highlight_fragment_anchors` — created alongside the highlight row.
- `note_blocks` + `resource_edges (origin='highlight_note')` — created by the existing note attachment path.

The Deepgram `transcribe_raw_audio` path produces no new DB rows. It is a pure synchronous transform.

---

## 6. API

### New

| Method | Path | Owner | Notes |
|---|---|---|---|
| `POST` | `/api/walknotes/transcribe` | BFF (`app/api/walknotes/transcribe/route.ts`) | Proxies multipart to FastAPI |
| `POST` | `/walknotes/transcribe-audio` | FastAPI (`api/routes/walknotes.py`) | Auth + entitlement + Deepgram raw-audio |

### Reused unchanged

| Method | Path | What walknotes uses it for |
|---|---|---|
| `GET` | `/api/media/{id}/fragments` | Resolve `position_ms` → fragment at materialize |
| `POST` | `/api/fragments/{id}/highlights` | Create anchored highlight |
| `PUT` | `/api/highlights/{id}/note` | Attach transcribed voice text as note body |

---

## 7. Frontend

| File | Action |
|---|---|
| `lib/walknotes/walknoteSession.ts` | New — `WalknoteWaypoint` type + `useWalknoteSession` context hook |
| `lib/walknotes/useVoiceRecorder.ts` | New — MediaRecorder lifecycle, duration cap, permission error typing |
| `lib/walknotes/transcribeAudio.ts` | New — `POST /api/walknotes/transcribe` client call |
| `lib/walknotes/pmDoc.ts` | New — `pm_doc_from_text(text: string)` pure helper |
| `components/walknotes/WalknoteReviewPanel.tsx` | New — review sheet with keep/discard + materialize |
| `components/walknotes/WalknoteReviewPanel.module.css` | New |
| `components/GlobalPlayerFooter.tsx` | Modified — Mark button + waypoint badge + session hook |
| `lib/security/headers.ts` | Modified — `microphone=()` → `microphone=(self)` |
| `app/api/walknotes/transcribe/route.ts` | New — BFF proxy (multipart, raw forward) |

---

## 8. Key decisions

**D-1. No backend persistence before materialize (rejected: staging table).**
Waypoints live in `sessionStorage`. A `walknote_staging_waypoints` table would add a migration, cleanup jobs, and a sync boundary. The use case is same-session: you walk, you come home, you materialize. Closing the tab is an acceptable loss for prototype-grade simplicity.

**D-2. Deepgram receives raw bytes directly (rejected: upload-to-R2-then-signed-URL).**
R2 staging adds a write, a presign, and a delete operation plus R2 fees. Deepgram's `/v1/listen` accepts raw binary bodies natively. A new `transcribe_raw_audio` method adds ≈ 20 lines to `deepgram_adapter.py` with no storage dependency.

**D-3. No new `resource_edges.origin` kind for walknotes (rejected: `origin='walknote'`).**
Walknote highlights are indistinguishable from user-created ones after materialize. The session boundary is entirely client-side. Adding a new origin would require widening the `ck_resource_edges_origin` CHECK and a migration for no product-visible gain.

**D-4. Transcription is synchronous at recording stop (rejected: deferred to materialize).**
The review panel is much more useful with real text visible before the user makes keep/discard decisions. A short Opus clip transcribes in < 5 seconds; the "Transcribing..." indicator is brief. Deferring transcription to materialize would mean the user reviews a list of timestamp stubs with no text preview.

**D-5. No daily-note machine line (rejected: machine-authored daily entry).**
The dawn-write cutover (#4) owns the daily-note machine block. Walknotes producing a daily-note sidebar would be a cross-spec dependency on an unbuilt surface. Record the seam: once dawn-write lands, a `walknote_session_summary` step at materialize could optionally append a dated machine-text block to the daily page. That is a follow-up, not this cutover.

**D-6. No new document map lens (rejected: `walknotes` lens in `ReaderDocumentMapLensId`).**
After materialize, walknote highlights are standard highlights. The existing `highlights` lens shows them. Adding a lens that disappears after the session clears would be confusing. The session group view exists only in the review panel, which is ephemeral by design.

**D-7. Materialize panel is a `MobileSheet` overlay from the footer (rejected: dedicated pane route `/walknotes/review`).**
The queue panel (`GlobalPlayerQueuePanel`) already demonstrates this pattern. A pane route would require navigation state, a pane registration in `paneRouteTable.ts`, and a server-side loader. The materialize is a transient, session-scoped action that doesn't need a URL.

**D-8. Whole-fragment highlight at offsets `[0, len(canonical_text))` (rejected: sub-fragment codepoint matching).**
At a given millisecond position there is no sub-fragment selection signal. The fragment is the unit of alignment. A whole-fragment highlight has a valid `exact` (the full segment text), produces a real highlight with full quote triple, and is compatible with all downstream quote-to-chat and citation paths. A sub-fragment selection would require heuristics with no signal to drive them.

---

## 9. What dies

Nothing is deleted by this cutover. This is an additive feature. There are no legacy paths to remove.

---

## 10. Sibling cutovers and sequencing

- **Depends on #1 (machine-hand)**: If voice transcription text is eventually rendered with the Machine Hand register, `WalknoteReviewPanel` would wrap the transcript preview in `MachineText`. Not a hard dependency for V1.
- **Sibling to #4 (dawn-write)**: The optional daily-note seam is explicitly deferred. The materialize function should accept a `dailyNoteAppend?: boolean` flag when that spec lands.
- **No conflict with #8 (reader-sidecar-consolidation)**: Walknotes produce standard highlights that surface in whatever sidecar/evidence surface survives that cutover.
- **No conflict with #6 (browse-surface-deletion), #7 (daily-surface-consolidation)**: No routing dependency.

---

## 11. Slices

### S0 — `useWalknoteSession` + client session model (no UI)

Create `lib/walknotes/walknoteSession.ts`: `WalknoteWaypoint` type, `WalknoteSessionContext`, `useWalknoteSession` hook backed by `sessionStorage`. Expose: `waypoints`, `addWaypoint(media_id, position_ms)`, `updateWaypointVoice(id, status, text?)`, `removeWaypoint(id)`, `materialize(keptIds)` (stub), `clearSession()`.

Mount `WalknoteSessionProvider` (exported from `walknoteSession.ts`) in `apps/web/src/app/(authenticated)/AuthenticatedShell.tsx` alongside `GlobalPlayerProvider`, wrapping the same subtree (line 94 pattern). Do not mount it inside `GlobalPlayerFooter`'s return JSX — top-level mounting preserves cross-surface access for future follow-ons.

**Verification:** unit test in `lib/walknotes/walknoteSession.test.ts` — add, update, remove, session persistence across a re-mount.

### S1 — Mark button on `GlobalPlayerFooter` (tap only)

Add `useWalknoteSession` to `GlobalPlayerFooter`. Add a "Mark" button (`aria-label="Mark waypoint"`) per the layout placement table in §4.4. Single tap calls `addWaypoint(track.media_id, Math.floor(currentTimeSeconds * 1000))`. Add a review button with `aria-label={`Review waypoints (${waypointCount})`}` and an `aria-hidden` child span for the visual count (same pattern as the queue button at GlobalPlayerFooter.tsx:510/694 — no separate badge element).

No review panel yet. Waypoints accumulate silently.

**Verification:** browser test in `__tests__/components/GlobalPlayerFooter.test.tsx` — mark button appears during playback, tap increments count (query by `role=button, name=/Review waypoints/`).

### S2 — `WalknoteReviewPanel` + materialize (text-only path)

Create `components/walknotes/WalknoteReviewPanel.tsx` as a `MobileSheet` (pattern: `GlobalPlayerQueuePanel`). Implement:
- Waypoint list: formatted `HH:MM:SS` timestamp, voice text or `(tap only)`, keep/discard toggle.
- "Materialize" button: calls real `materialize(keptIds)` which fetches fragments, resolves positions, `createHighlight`, and optionally `saveHighlightNote`.
- "Discard all" button.

Wire the review button in `GlobalPlayerFooter` to open the panel.

**Verification:** two scopes — (1) browser test for pure UI behavior: panel opens, waypoint list renders, keep/discard toggle changes state, "Discard all" clears session — no materialize call needed and no internal mocks; (2) materialize correctness (real `createHighlight` + `saveHighlightNote` calls against a real DB) belongs in the §S4–S5 backend integration test with real fragment rows. Do not mock `createHighlight` in browser tests (testing standards §7: internal API helpers must not be `vi.mock`-ed).

### S3 — Voice recording (MediaRecorder + Permissions-Policy)

Change `lib/security/headers.ts:39`: `"microphone=()"` → `"microphone=(self)"`.

Create `lib/walknotes/useVoiceRecorder.ts`: `getUserMedia({ audio: true })`, `MediaRecorder` start/stop, auto-stop at `MAX_VOICE_NOTE_DURATION_MS = 120_000`, return `{ blob: Blob; durationMs: number }`. Typed errors: `E_MIC_DENIED` (NotAllowedError), `E_MIC_UNAVAILABLE` (NotFoundError).

Add hold-to-speak interaction to the "Mark" button in `GlobalPlayerFooter`: `onPointerDown` starts a 500 ms timer; if still held, begins recording; `onPointerUp` stops. Visual indicator: `data-recording="true"` on the button.

**Verification:** unit test for `useVoiceRecorder` (mock `getUserMedia`); browser test asserting permission error is surfaced.

### S4 — `POST /walknotes/transcribe-audio` (backend + BFF)

Create `python/nexus/api/routes/walknotes.py`:
- `POST /walknotes/transcribe-audio`: multipart body (`audio: UploadFile`, `content_type: str`). Check `can_transcribe`. Size gate: reject > 10 MB. Call `get_deepgram_client().transcribe_raw_audio(await audio.read(), content_type)`. Return `{"transcript": str, "duration_ms": int | null}` or typed `ApiError`.

Add `DeepgramClient.transcribe_raw_audio(audio_bytes: bytes, content_type: str) -> TranscriptionResult` in `services/podcasts/deepgram_adapter.py`: POST bytes to `/v1/listen`, `Content-Type: {content_type}`, same params as diarization-disabled path, same error mapping.

Register router in `python/nexus/api/routes/__init__.py`: import the new module at the top alongside the other router imports, then call `api_router.include_router(walknotes_router)` inside `create_api_router()`.

Create `apps/web/src/app/api/walknotes/transcribe/route.ts`: `export async function POST` proxying multipart body via `proxyToFastAPI`.

Create `lib/walknotes/transcribeAudio.ts`: `transcribeAudio(blob: Blob): Promise<string>` — builds FormData, calls `/api/walknotes/transcribe`, returns transcript text.

**Verification:** unit test for `transcribe_raw_audio` (mock `httpx.post`). Integration test: `POST /walknotes/transcribe-audio` with a test audio fixture returns transcript text.

### S5 — Connect voice recording to session + note attachment

Wire S3 and S4 together in `GlobalPlayerFooter`:
- On recording stop: call `transcribeAudio(blob)`, call `updateWaypointVoice(id, 'transcribing')` → on success `updateWaypointVoice(id, 'done', text)` → on failure `updateWaypointVoice(id, 'failed')`.
- In `materialize`: if `voice_text !== null` call `saveHighlightNote`.

Add `lib/walknotes/pmDoc.ts`: `pm_doc_from_text(text: string)` returning `{ type: "paragraph", content: [{ type: "text", text }] }`.

**Verification:** E2E or integration test — record simulated audio, verify transcription round-trip, materialize produces highlight with note body text matching transcript.

---

## 12. Acceptance criteria

**AC-1.** Tapping "Mark" during any playing podcast episode adds a `WalknoteWaypoint` to the session; the review button `aria-label` count increments.

**AC-2.** Holding "Mark" > 500 ms transitions to recording state; releasing creates a waypoint with `voice_status: 'recording'` that resolves to `'done'` or `'failed'` after the transcription round-trip.

**AC-3.** `WalknoteReviewPanel` lists all session waypoints with formatted `HH:MM:SS` timestamps.

**AC-4.** "Materialize" on a tap-only waypoint: a `highlights` row is created with `anchor_kind='fragment_offsets'`, anchored to the fragment whose `t_start_ms <= position_ms <= t_end_ms` (or nearest fragment when the position falls in a gap). The `exact` field equals the fragment's `canonical_text`.

**AC-5.** "Materialize" on a voice waypoint: a `highlight_fragment_anchors` row plus a `note_blocks` row with `body_text` equal to the Deepgram transcript are created; `resource_edges` has one row with `origin='highlight_note'`.

**AC-6.** If `can_transcribe` is false, the hold-to-speak interaction is disabled; tap-only materialize still works.

**AC-7.** Audio longer than `MAX_VOICE_NOTE_DURATION_MS` (120 s) is auto-stopped; the backend rejects bodies over 10 MB.

**AC-8.** `POST /walknotes/transcribe-audio` returns `E_PODCAST_QUOTA_EXCEEDED` (HTTP 429) when `can_transcribe` is false.

**AC-9.** After materialize, the session clears and the episode's Highlights lens shows the new highlight(s).

**AC-10.** `Permissions-Policy` response header includes `microphone=(self)`.

---

## 13. Negative gates

```
# No walknote origin in resource_edges CHECK — standard highlight_note only
grep -rn "walknote" python/nexus/db/models.py
# must be empty

# No R2 storage path for voice audio
grep -rn "walknote" python/nexus/storage/paths.py
# must be empty

# No new background job kind
grep -rn "walknote" python/nexus/jobs/registry.py
# must be empty

# Permissions-Policy must grant microphone to self only
grep "microphone" apps/web/src/lib/security/headers.ts
# must print exactly: "microphone=(self)"

# DeepgramClient.transcribe (URL path) is unchanged
grep -n "def transcribe\b" python/nexus/services/podcasts/deepgram_adapter.py
# must still exist at its current definition site (not removed)

# No inline fragment highlight creation outside highlights.py
grep -rn "highlight_fragment_anchors" python/nexus --include="*.py" | grep -v "highlights.py" | grep "INSERT"
# must be empty
```

---

## 14. Test plan

| Test | Kind | File |
|---|---|---|
| `useWalknoteSession` add/update/remove/persist | Unit | `lib/walknotes/walknoteSession.test.ts` |
| `useVoiceRecorder` permission denied + auto-stop | Browser | `lib/walknotes/useVoiceRecorder.test.tsx` (must be `.tsx` — wraps `getUserMedia`/`MediaRecorder`, which are browser APIs absent in Node) |
| Mark button renders/tap when track present | Browser | `__tests__/components/GlobalPlayerFooter.test.tsx` |
| Review panel open/close/discard; keep/discard toggle; "Discard all" clears session (UI behavior only — no internal mocks) | Browser | `components/walknotes/WalknoteReviewPanel.test.tsx` |
| `DeepgramClient.transcribe_raw_audio` success + errors | Unit | `python/tests/test_deepgram_adapter.py` |
| `POST /walknotes/transcribe-audio` auth + entitlement gate + size gate | Integration | `python/tests/test_walknotes.py` |
| `pm_doc_from_text('hello')` returns correct ProseMirror doc shape; `.content[0].content[0].text` traversal recovers input text | Unit | `lib/walknotes/pmDoc.test.ts` |
| `PERMISSIONS_POLICY` array includes `microphone=(self)` after the change | Unit | `apps/web/src/lib/security/headers.test.ts` (create if absent; `Permissions-Policy` is emitted by Next.js, not FastAPI) |

E2e: defer — mobile MediaRecorder in Chromium-driven Playwright has device-level constraints; mock the voice path for now.

---

## 15. Files touched / created / deleted

### Created

- `python/nexus/api/routes/walknotes.py`
- `apps/web/src/app/api/walknotes/transcribe/route.ts`
- `apps/web/src/lib/walknotes/walknoteSession.ts`
- `apps/web/src/lib/walknotes/walknoteSession.test.ts`
- `apps/web/src/lib/walknotes/useVoiceRecorder.ts`
- `apps/web/src/lib/walknotes/useVoiceRecorder.test.tsx`
- `apps/web/src/lib/walknotes/transcribeAudio.ts`
- `apps/web/src/lib/walknotes/pmDoc.ts`
- `apps/web/src/lib/walknotes/pmDoc.test.ts`
- `apps/web/src/components/walknotes/WalknoteReviewPanel.tsx`
- `apps/web/src/components/walknotes/WalknoteReviewPanel.module.css`
- `apps/web/src/components/walknotes/WalknoteReviewPanel.test.tsx`
- `python/tests/test_walknotes.py`
- `python/tests/test_deepgram_adapter.py`

### Modified

- `python/nexus/services/podcasts/deepgram_adapter.py` — add `transcribe_raw_audio`
- `python/nexus/api/routes/__init__.py` — register `walknotes` router
- `apps/web/src/components/GlobalPlayerFooter.tsx` — Mark button, hold-to-speak, review button with embedded waypoint count
- `apps/web/src/__tests__/components/GlobalPlayerFooter.test.tsx` — new cases
- `apps/web/src/lib/security/headers.ts` — `microphone=(self)`

### Deleted

Nothing.

---

## 16. Risks

**R-1. Fragment gap at exact position (HIGH — mitigated).** If `position_ms` falls in a gap between two fragment time ranges, `findNearestTranscriptFragmentByStartMs` returns the closest fragment by `t_start_ms` distance. This is documented in the existing function. The highlight's `exact` text will be the nearest segment, which may not contain the exact word that struck the listener. Acceptable for V1; the timestamp shown in the review panel lets the user judge.

**R-2. MediaRecorder compatibility (MEDIUM).** Android WebView requires the APK to hold `android.permission.RECORD_AUDIO`. The web-level `getUserMedia` permission prompt will appear on first use; the APK shell's WebView configuration must not suppress it. Verify with the device-side APK build before shipping voice notes to the Android app. Tap-only mode degrades gracefully.

**R-3. Deepgram raw-audio path is untested against live provider (LOW — mitigated).** The `transcribe_raw_audio` unit test mocks `httpx.post`. Add a `make test-live-providers` case parallel to the existing URL-based podcast transcription live proof, gated on `DEEPGRAM_API_KEY`.

**R-4. `microphone=(self)` security scope (LOW — must document).** Granting microphone to `self` expands the privilege surface. The scope is locked to first-party origin only (no iframes). Any future third-party iframe must not inherit this grant (Permissions-Policy delegation requires explicit `allow="microphone"` on the iframe, which the YouTube embed does not have and must not get).

**R-5. Fragment-to-position alignment only exists for podcast episodes with transcripts (LOW — by design).** If `GET /api/media/{id}/fragments` returns an empty list or fragments with null timestamps, `resolveActiveTranscriptFragment` returns the first fragment or null. A null result at materialize time produces a client-side typed error — define `E_WALKNOTE_NO_FRAGMENT = 'E_WALKNOTE_NO_FRAGMENT'` as a string constant in `lib/walknotes/walknoteSession.ts` (this is a TypeScript constant, not a Python `ApiErrorCode`). The user is shown "Could not find transcript position" for that waypoint; other waypoints proceed.
