# release highlight excerpts

implementation in progress; release pending. binding cutover for
[highlight excerpts](../highlight-excerpts-spec.md); one user, all devices paired.
no release or data mutation is authorized by creating this record.

problem: adding the frozen excerpt changes authored grammar and historical
evidence. upgrading only current rows leaves old feed payloads and local pending
commands incompatible. accepted source command contents must remain immutable
(`python/nexus/services/authored/__init__.py:220-230`).

## preparation and admission

- implement one alembic migration after the actual head; freeze its conversion
  logic, import no nexus application code, state all data effects and raise on
  unsupported data. authored format becomes 2; apply the wire revision's existing
  once-between-releases rule. build matched web/helper/android assets.
- wire 17 is already the pending break after released wire 16 (`3d81ef45e`);
  retain 17 for this paired release. verify the deployed boundary before release;
  if 17 has since shipped, the next break needs a fresh revision.
- qualify conversion on a restored backup. inventory quote-bearing durable json:
  canonical highlight/passaged captures, `messages.reader_selection_snapshot`,
  `message_retrievals.captured_evidence`, and citation `resource_edges.snapshot`.
  freeze an explicit table/path list; do not recursively rewrite arbitrary json.
  verify record counts, actual saved strings, ids, causal vectors, stamps, nullable
  publication, targets, attribution, colors and acceptance counters.
- check converted capture/update sizes against existing command/snapshot limits.
  never trim to fit. identify any offending record for explicit live repair before
  cutover. preserve a backup; do not discard writing to clear a preflight.
- stop new authored commands on every device; drain uploads and remote writers,
  then pull every device through final account head. verify pending count zero and
  local source sequence equals accepted sequence. unavailable/unsynced devices block.
- stop server writers and take the deployment controller's verified backup.
  record final account head `h` and the paired artifact identities privately.

## migration effects

1. convert current canonical captures to the single v2 grammar. conservatively
   seed actual saved text with unknown structure for old reflowable captures;
   pdf/plain sources retain explicit plain behavior. concatenate existing strings
   exactly and mark selection by codepoint lengths. never consult current sources.
   highlights use saved selection strings; historical quotes use their own strings.
   passages use `capture.quote_exact`; use retained selector affixes only when its
   exact equals that string, source agrees, and normalized selector equals the
   stored passage binding. otherwise affixes are null, never normalized identity.
   classify pdf/plain only from retained locator/source facts; uncertainty is
   unknown. freeze this mapping for each durable path.
2. convert listed historical quote objects without changing their saved words,
   targets, metadata, colors or rationales. absent quotes stay absent. opaque tool
   receipts remain untouched unless an actual typed reader requires conversion;
   inventory that reader before implementation, never add a legacy decoder.
3. add/rebuild bounded `highlights.excerpt_preview` and
   `passage_anchors.excerpt_preview`. keep full excerpt in canonical authored state;
   historical evidence owns its own immutable snapshot. freeze the v2 kernel's
   serializer/projection with migration code; prove preview/revision equality with
   runtime for unicode and pdf numeric locators. python's json spelling is not
   a substitute for the kernel's canonical serialization.
4. preserve `authored_changes` byte-for-byte and all accepted source prefixes.
   add `authored_heads.min_feed_cursor` default 0; set each existing account's floor
   to `h`. v2 download rejects `after < floor` with `E_INVALID_CURSOR` before
   decoding rows. old feed records are opaque receipts, never v2 inputs. do not
   reset head/lamport or invent accepted commands for the conversion.
5. retain resource/passage/link ids, source stubs, register stamps and causal state.
   v2 snapshots at head expose only converted current state. new writes append
   after the preserved source sequence and account head.

## device transition and release

deploy paired clients before reopening writing. the one-time storage transition
reads only prior format metadata and pending-row count. in one transaction require
format 1 and zero pending rows, apply the device schema change, retire old authored
rows/projections, set format 2 and provisioning incomplete, and preserve replica
identity, source sequence and clocks. nonempty pending rows refuse; old command
bodies are never parsed or rewritten. existing snapshot staging/completion replaces
state and derived indexes; interruption restarts provisioning with writing disabled.
this finite storage migration remains, but no runtime can read/write v1 content.
preserve account state and downloaded sources; do not use android signout or clear
the whole application.

verify exact database head, v2 provision/snapshot/above-floor catch-up, below-floor
refusal, old-client refusal, id-preserving offline reads, subsequent color/resize
commands, historical quotation reads and unchanged pdf behavior on both platforms.
exercise the pending-write refusal before any real retirement. no partial-pair
release, automatic data deletion or silent source reconstruction.

rollback requires restoring the paired database/device backups and old binaries
while writers remain stopped. after new writes resume, use explicit repair; do
not replay v2 writes into v1. this is a short coordinated cutover, not a rolling
compatibility deployment.

resolved when the paired release and device qualification satisfy these checks,
all writing is preserved, no old reader path remains, and required evidence is
recorded in the implementation pr. remove this record only then.
