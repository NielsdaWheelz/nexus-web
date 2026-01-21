s1_pr_roadmap.md — slice 1 (compressed): web article ingestion (read-only)

assumptions
	•	slice 0 is complete and merged (auth, libraries, can_view, visible_media_ids, integration test harness)
	•	migrations: alembic
	•	jobs: celery
	•	headless browser: playwright
	•	images: proxied on-demand (no image downloads/storage in s1)
	•	links must remain functional (relative→absolute; preserve in-doc #anchors)

⸻

PR-A — schema + api skeleton + dedup attach

goal
create the persistence layer and minimal api surface so the frontend can create/attach media and poll status.

includes
	•	alembic migrations:
	•	media table (web_article fields per s1_spec)
	•	fragment table (single fragment for web_article)
	•	unique index: (kind, canonical_url) (web_article)
	•	service logic:
	•	validate target_library_id + admin role
	•	dedup attach: insert-or-select by canonical_url (conflict-safe)
	•	create library_media row (or noop if exists)
	•	api routes (enveloped responses):
	•	POST /media/web-articles
	•	GET /media/:id (metadata only)
	•	GET /media/:id/fragments (only allowed if ready_for_reading)
	•	visibility:
	•	enforce can_view / visible_media_ids on all reads
	•	forbidden reads return 404
	•	tests:
	•	db constraint test for uniqueness
	•	integration test: user A cannot read user B’s media unless shared library contains it
	•	integration test: two ingests of same canonical_url converge on one media row

explicitly not
	•	no celery wiring
	•	no fetching/extraction/sanitization/canonicalization

acceptance
	•	schema migrated + validated
	•	endpoints behave with correct auth + 404-on-forbidden
	•	dedup attach works under concurrency (transactional test)

⸻

PR-B — ingestion job end-to-end (fetch → readability → sanitize → canonicalize → persist)

goal
a submitted url becomes readable (ready_for_reading) with immutable fragment artifacts.

includes
	•	celery wiring:
	•	worker config
	•	task ingest_web_article(media_id)
	•	enqueue from POST /media/web-articles when new media row created
	•	pipeline (single task; artifact persistence atomic):
	1.	url validate
	2.	playwright fetch with redirects (max 5)
	3.	canonical_url derivation:
	•	final network redirect url only (ignore JS redirects after navigation)
	•	strip fragment for canonical_url only
	•	lowercase scheme/host; drop default ports
	4.	fetch hardening:
	•	block private ip ranges + localhost + link-local + .local + cloud metadata ips
	•	block redirects to blocked ranges
	•	timeouts + max response size + max dom size for readability
	5.	readability extraction; empty → E_EXTRACT_NO_CONTENT
	6.	sanitize via bleach (no scripts/styles/forms/iframes/svg/base/meta/link; unwrap unknown tags)
	7.	link rewriting:
	•	relative <a href> → absolute based on canonical_url
	•	preserve #anchors on in-doc links
	•	add target=_blank, rel=noopener noreferrer, referrerpolicy=no-referrer
	8.	canonical_text generation per constitution
	9.	single db transaction:
	•	insert fragment(ordinal=0, html_sanitized, canonical_text)
	•	set media.processing_status=ready_for_reading, clear failure fields
	•	failure taxonomy + retries:
	•	set failed with failure_code + failure_message
	•	auto retry only for E_FETCH_FAILED (N attempts, exponential backoff)
	•	manual retry endpoint or action (reuse same media_id; deletes fragments; resets status)
	•	tests:
	•	happy path: ingest → ready_for_reading → fragments readable
	•	failure: extract no content → failed + retry works
	•	security: blocked private ip url fails with E_FETCH_FORBIDDEN

explicitly not
	•	no image proxy yet (images may be stripped or temporarily retained but must not violate sanitization constraints)
	•	no frontend UI changes beyond polling (if needed)

acceptance
	•	end-to-end ingestion works for normal article urls
	•	artifacts are immutable after ready_for_reading
	•	no partial fragments persisted on failure/crash
	•	retry re-runs extraction correctly

⸻

PR-C — image proxy + image rewriting + SSRF hardening (images)

goal
images render while preventing privacy leaks and SSRF.

includes
	•	sanitizer rule: external images do not survive; all <img src> rewritten to proxy URLs
	•	proxy strategy (no storage table in s1):
	•	rewrite <img src> to /images/proxy?u=<url>&sig=<hmac>&exp=<ts> OR similar signed token scheme
	•	token is tamper-proof; url may be base64-encoded but is not “secret”
	•	fastapi route:
	•	GET /images/proxy (or /images/:token)
	•	validates signature + expiry
	•	reuses the same SSRF hardening rules as fetcher (private ip block, redirects, size limits)
	•	validates content-type allowlist image/* excluding svg
	•	sets caching headers (short TTL) + strips upstream caching surprises
	•	link/image rewrite tests:
	•	<img> becomes proxy url
	•	proxy rejects svg, html, oversized
	•	proxy rejects private ip / metadata ip

explicitly not
	•	no downloading/storing images in supabase storage
	•	no srcset support

acceptance
	•	proxied images render in the article
	•	proxy cannot be used to fetch internal resources
	•	no external image URLs remain in stored html_sanitized

⸻

PR-D — e2e + integration hardening (user-visible acceptance)

goal
prove the slice actually works in the UI and doesn’t leak.

includes
	•	playwright e2e:
	•	submit url → pending state → readable state
	•	verify sanitized html renders
	•	verify at least one proxied image loads (mock or controlled host)
	•	verify links open in new tab and preserve anchors where applicable
	•	integration tests:
	•	404-on-forbidden for media + fragments
	•	dedup attach across two users
	•	snippetless leak check: fragments endpoint never returns canonical_text
	•	docs:
	•	dev commands for worker + api + frontend

explicitly not
	•	no performance tuning beyond “not obviously broken”

acceptance
	•	all e2e + integration tests pass
	•	slice 1 acceptance criteria satisfied

⸻

slice 1 completion gate

slice 1 is done when:
	•	user can ingest a web url and read it (ready_for_reading)
	•	dedup by canonical_url works
	•	sanitizer invariants hold (no active content; no external image src)
	•	proxy images render and are SSRF-hardened
	•	forbidden reads return 404
	•	retry works without creating new media ids