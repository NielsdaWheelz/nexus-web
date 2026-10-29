# release highlight excerpts

implementation and combined format-3 migration/device qualification complete;
paired production release pending.
binding cutover for
[highlight excerpts](../modules/highlight.md#frozen-excerpts); one user, all devices paired.
no release or data mutation is authorized by creating this record.

problem: adding the frozen excerpt changes authored grammar and historical
evidence. upgrading only current rows leaves old feed payloads and local pending
commands incompatible. accepted source command contents must remain immutable
(`python/nexus/services/authored/__init__.py:220-230`).

## preparation and admission

- apply excerpt migration 0326 after x capture 0324 and chat selections 0325; freeze its conversion
  logic, import no nexus application code, state all data effects and raise on
  unsupported data. authored format becomes 3; apply the wire revision's existing
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

1. convert current canonical captures to the single v3 grammar. conservatively
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
   historical evidence owns its own immutable snapshot. freeze the v3 kernel's
   serializer/projection with migration code; prove preview/revision equality with
   runtime for unicode and pdf numeric locators. python's json spelling is not
   a substitute for the kernel's canonical serialization.
4. preserve `authored_changes` byte-for-byte and all accepted source prefixes.
   reuse `authored_heads.snapshot_floor_seq`; set each existing account's floor
   to `h`. v3 download rejects `after < floor` with `E_INVALID_CURSOR` before
   decoding rows. old feed records are opaque receipts, never v3 inputs. do not
   reset head/lamport or invent accepted commands for the conversion.
5. retain resource/passage/link ids, source stubs, register stamps and causal state.
   v3 snapshots at head expose only converted current state. promote existing
   replica format metadata from 1 or 2 to 3 without changing accepted prefixes.
   uploads require an explicit format-3 envelope before replay comparison; this
   blocks older wire-17 clients while preserving replica identities. the reserved
   server:2 producer continues its accepted sequence. new writes append after the
   preserved source sequence and account head.

## device transition and release

annotation migration 0327 follows excerpt migration 0326 and advances the combined
grammar to format 4. its private body fields change both client and server grammar;
format-3 excerpt clients cannot participate. runtime rejects old local stores.
after proving every outbox empty, explicitly retire authored device state and
bootstrap a complete snapshot with a fresh replica, preserving downloaded sources
and unrelated account state. no old command bytes are decoded or replayed.

verify exact database head, v4 provision/snapshot/above-floor catch-up, below-floor
refusal, old-client refusal, id-preserving offline reads, subsequent color/resize
commands, historical quotation reads and unchanged pdf behavior on both platforms.
exercise the pending-write refusal before any real retirement. no partial-pair
release, automatic data deletion or silent source reconstruction.

rollback requires restoring the paired database/device backups and old binaries
while writers remain stopped. after new writes resume, use explicit repair; do
not replay v4 writes into earlier formats. this is a short coordinated cutover, not a rolling
compatibility deployment.

resolved when the paired release and device qualification satisfy these checks,
all writing is preserved, no old reader path remains, and required evidence is
recorded in the implementation pr. remove this record only then.
