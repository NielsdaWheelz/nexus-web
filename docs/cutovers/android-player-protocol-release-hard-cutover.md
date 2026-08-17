# Android Player Protocol Release Hard Cutover

Status: **IMPLEMENTED LOCALLY — merge, signed release, production, and device evidence pending**

## Questions and assumptions

No blocking question remains.

- This cutover owns the diagnosed web/native player protocol skew and its
  release sequence. It does not change playback behavior.
- One supported installed state exists: the current signed Android APK whose
  player identity exactly matches the production web build.
- A short, explicit one-user maintenance window is acceptable. Cross-version
  operation during the cutover is intentionally unsupported.
- `docs/rules/*`, `docs/local-rules/codebase.md`, and
  `docs/local-rules/testing-standards.md` control implementation and proof.

## Problem

The web added required `activitySync` fields to `PlayerSnapshot` while both
sides still advertised player protocol `1`. The published Android APK predates
those fields. Its valid `Absent` snapshot therefore fails the current web's
strict decoder and is projected as a retryable “invalid response.” Retry
reconnects the same incompatible pair and cannot recover.

This is a release-contract defect, not a Media3, source, network, or playback
failure. The repository already declared old Android builds unsupported after
the Consumption Activity cutover, but no executable release gate enforced that
decision.

## Goal

Make web/native player compatibility explicit, user-actionable, and impossible
to violate through the normal release path:

1. one exact player protocol identity;
2. one strict v2 wire contract on both sides;
3. one non-retryable Update Required product state for identity mismatch;
4. one signed-APK manifest carrying the identity; and
5. one fail-closed production gate before any promotion or host mutation.

Success lowers complexity: no negotiation, compatibility decoder, fallback,
duplicate schema constant, or second release system remains.

## Target behavior

| Observation | Required result |
|---|---|
| Web and native identities match; snapshot is valid | Existing player state and behavior continue unchanged. |
| Version or contract digest differs | Global player shows **Update Nexus for Android**, an **Update** action to `/android`, and no Retry action. No body is interpreted. |
| Identity matches; payload violates v2 | Defect through the existing async/root defect path. Never relabel same-system corruption as Update Required or retryable unavailability. |
| Bridge is absent, times out, or is transiently unavailable | Existing retryable Player unavailable behavior remains. |
| GitHub's latest release is not one stable compatible Android release with one manifest | A new production release stops before Vercel promotion or host mutation. |
| Production is compatible | `/version` reports the exact web player identity used by the running build. |

Copy is direct and calm:

- title: `Update Nexus for Android`
- body: `This app version no longer matches the Nexus player.`
- action: `Update` → existing `/android`

## Final architecture

```text
testdata/android/player-protocol.json
        │ exhaustive v2 oracle + SHA-256 identity
        ├── web build → bridge envelopes → /version
        ├── Android build → BuildConfig + APK manifest → bridge envelopes
        ├── signed-release proof → release-manifest.json
        └── production preflight: exact-SHA web identity == stable APK identity
```

### 1. Canonical identity

Create `testdata/android/player-protocol.json` as the sole protocol oracle. It
contains one independently reviewed canonical example for every command,
reply, event, rejection, snapshot variant, and owned nested variant. Exact key
sets make the corpus exhaustive, not illustrative.

Its top-level inventory lists the exact discriminants for every command,
reply/event, snapshot, rejection code, enum, and nested tagged union. Web tests
use compile-time exhaustive keyed tables over the production TypeScript unions;
Android tests use exhaustive `when` expressions over sealed types and compare
`Enum.entries`. Both tables must equal the corpus inventory. A new production
arm therefore fails proof until the corpus changes; a changed required field
fails the existing canonical example. Do not add a production registry solely
for this test.

The identity is:

```ts
type AndroidPlayerProtocolIdentity = {
  protocolVersion: 2;
  protocolContractSha256: string; // lowercase 64-hex
};
```

The SHA-256 is over the raw bytes at the exact repository-relative path
`testdata/android/player-protocol.json`. The file is UTF-8 without BOM, LF-only,
and has exactly one trailing LF; `.gitattributes` enforces LF and the corpus
proof rejects any other byte form. Hash bytes directly—never decoded or
re-serialized JSON. Corpus envelopes use the literal
`$PROTOCOL_CONTRACT_SHA256`; test materializers replace that token after hashing.
The digest therefore never hashes itself. The matching `testdata/manifest.json`
artifact digest must be identical; it is not a second identity.

- `next.config.ts` hashes the corpus and injects the digest into the web build.
- Android Gradle hashes the same file and emits it into `BuildConfig` and APK
  manifest metadata.
- Production code does not load the corpus at runtime.
- Do not hand-copy a digest, generate checked-in bindings, or add a schema
  framework. A changed wire shape must change the corpus and therefore the
  identity.

### 2. Wire capability contract

Every command, reply, and event has the exact envelope fields:

```json
{
  "protocolVersion": 2,
  "protocolContractSha256": "<64 lowercase hex>",
  "kind": "<existing discriminant>",
  "...": "<existing v2 body>"
}
```

`activitySync` remains required in every v2 `PlayerSnapshot`. All other player
commands, events, state transitions, session fences, and playback semantics are
unchanged.

`NaturalEndPending` is an operational barrier, not transport failure and not a
user-retry state. Web retains one in-flight `SessionIntent` and queues later
exact session intents FIFO. It replays the retained intent only after the
matching observed receipt settles and native `AcknowledgeNaturalEnd` is
accepted, then drains the queue; stale intent is discarded without blocking the
pump. Independent `PodcastSettings` and `ListeningProjection` operations are
bounded latest-wins keys. No barrier path renders the generic Retry action.

Ingress on each side has exactly two phases:

1. Parse only `requestId` where applicable and the two identity fields.
2. On an exact identity match, invoke the existing strict full-body decoder.

Web ingress first reads the bounded integer version. A non-v2 version throws
one typed `AndroidPlayerUpdateRequiredError` without requiring any other field.
For v2, a missing or malformed digest is a defect; a valid nonmatching digest
throws the same update error. Only an exact match reaches the body decoder. The
runtime projects the typed error to a dedicated
`GlobalPlayerState.UpdateRequired`; it never enters retryable `RuntimeFailed`.

Native version or valid-digest mismatch does not parse the command body. When
`requestId` is replyable, it returns exact v2 `Rejected` with code
`ProtocolMismatch` and its current identity. Unreplyable JSON remains ignored.
Malformed v2 identity or matching-identity invalid input remains
`InvalidRequest`.

`PlayerWire.parseCommand` is the sole native rejection classifier:
`PlayerCommandParseResult.Rejected` carries its `PlayerRejectionCode`.
`NexusPlayerBridge` and `NexusPlaybackService` only serialize that result; they
must not replace it with `InvalidRequest`. This removes the current duplicate
mapping without introducing another layer.

Minimal envelope classification is not a legacy decoder: no v1 body is
accepted, normalized, or translated. An old v1 APK will reject a v2 command
with its v1 envelope; the web classifies that envelope as Update Required.

### 3. UI composition

- `AndroidPlayerRuntimeProvider` alone owns transport classification.
- `GlobalPlayerProvider` owns the exhaustive global player union and adds
  `UpdateRequired` without a retry callback.
- `playerChromeModel` maps that state to one presentation variant.
- `GlobalPlayerSurfaces` renders the shell-resident message and existing
  `/android` link. Browser playback never produces this state.
- Focus order, touch target, safe-area placement, and accessible name reuse the
  existing player failure surface primitives. No modal or toast is added.

### 4. Release contract

Hard-cut `release-manifest.json` to exact schema `2` and add:

```json
{
  "version": 2,
  "player_protocol": {
    "version": 2,
    "contract_sha256": "<64 lowercase hex>"
  }
}
```

All current provenance, tag, package, version, signature, APK digest, and asset
fields remain required. The release capability reads the identity from the
actual signed APK metadata and requires it to equal the repository corpus
before staging the manifest. There is no manifest-v1 parser.

The existing `/version` response hard-cuts to:

```json
{
  "source_sha": "<40 lowercase hex>",
  "player_protocol": {
    "version": 2,
    "contract_sha256": "<64 lowercase hex>"
  }
}
```

For a new candidate, `deploy/hetzner/deploy.sh` may first perform one read-only
probe of the exact immutable host bundle and its release state. Before bundle
installation, mutating SSH, Vercel operation, `_converge_resource_limits`, or
other host mutation, it resolves GitHub's canonical `releases/latest` pointer
and requires it to be one non-draft, non-prerelease Android release with one
`release-manifest.json`. This is the same pointer used by `/android`, so the
Update action and release gate cannot name different APKs. It invokes the local clean exact-SHA checkout's
`deploy/hetzner/release.py` to strictly decode that manifest and compare it with
the raw local `testdata/android/player-protocol.json` bytes. Shell owns
transport; the local release controller owns pre-mutation policy. Missing
asset, non-200 response, malformed JSON, wrong tag/package, or identity mismatch
fails closed.

Once that exact-SHA bundle has a durable release attempt, its raw corpus is the
resume and settlement authority. Resume, rollback, forward-fix settlement, and
verification of an already-current release do not reread mutable GitHub release
state or require GitHub availability.

The existing closed immutable backend release bundle also carries
`testdata/android/player-protocol.json` byte-for-byte. The backend-images
publisher, `fetch-release-bundle.sh`, and `release.py::_BUNDLE_FILES` admit
exactly that path and no generated or re-serialized copy. Remote `release.py`
hashes the bundled corpus for post-promotion `/version` proof and durable resume;
it does not add a second CLI input or persist duplicate protocol identity in the
release attempt. `next.config.ts` builds the candidate from the same corpus, and
`/version` proves the identity of the build that was actually promoted.

Exact source SHA equality between web and APK is not required. Exact protocol
identity is the compatibility contract, so unrelated web releases do not force
an APK release.

No database, backend domain API, migration, updater service, or new download
endpoint is introduced. `/android`, GitHub Releases, the release manifest, and
the production controller remain the owners.

## Hard-cut release order

1. Land the complete v2 implementation and proofs without promoting web.
2. Tag, certify, and publish stable signed Android `android-v0.2.14` / version
   code `17` from that exact source with `publish_stable=true`. A draft is not
   compatible release evidence.
3. Start the maintenance window and close Nexus on Android. Do not install or
   reopen the app while the deployed web still speaks v1.
4. Run production release. The stable-manifest preflight must pass before the
   candidate can be promoted.
5. After `/version` proves v2, install the signed APK from `/android`, reopen
   Nexus, and record the explicit operator smoke.

Do not publish v2 web first, dual-serve v1/v2, temporarily relax decoders, or
retain a switch after release.

## Implementation boundaries

Lanes are sequential at their declared handoff and otherwise non-overlapping.

| Lane | Sole write scope | Deliverable / handoff |
|---|---|---|
| A — Contract | This spec; `.gitattributes`; `testdata/android/player-protocol.json`; `testdata/{manifest,proofs}.json`; `testdata/faults/{manifest.json,android-player-protocol-skew-bypass.patch}`; `python/nexus_test_control/{model,policy}.py`; `python/tests/kernel/nexus_test_control/{test_model,test_policy,test_selection}.py` | Freeze byte-exact exhaustive v2 oracle, typed priority risk/ownership digest, and fault before implementation. |
| B — Web | `apps/web/{next.config.ts,vitest.config.ts}`; `app/android/{page.tsx,page.unit.test.tsx}`; `app/version/{route.ts,route.unit.test.ts}`; player `androidPlayer{Protocol,Client,Runtime}.ts(x)`, `browserPlayerRuntime.tsx`, `playerRuntime.tsx`, `playerChromeModel.ts`; `lib/actions/resourceActionRuntime.tsx`; `GlobalPlayerSurfaces{.tsx,.module.css,.browser.test.tsx}` | Strict identity/body decoder, typed state, exhaustive consumers, test-time digest injection, Update link ownership, UI, and web proofs. Consumes A read-only. Paths after the config entries are below `apps/web/src`. |
| C — Android | `apps/android/app/build.gradle.kts`; `src/main/AndroidManifest.xml`; playback `PlayerProtocol.kt`, `NexusPlayerBridge.kt`, `NexusPlaybackService.kt`; `PlayerProtocolTest.kt`, `NexusPlaybackServiceContractTest.kt` | Strict v2 native wire, one rejection classifier, embedded identity, native proof. Paths after Gradle are below `apps/android/app`. Consumes A read-only. |
| D — Release | `.github/workflows/backend-images.yml`; `python/nexus_test_control/runner.py`; `python/tests/kernel/nexus_test_control/test_runner.py`; `deploy/hetzner/{deploy.sh,fetch-release-bundle.sh,release.py}`; `python/tests/kernel/{test_backend_artifact,test_release_bundle_fetch,test_successor_release_contract,test_production_delivery_contract,test_production_release,test_production_deploy_behavior}.py`; `python/tests/testkit/{host_release,production_deploy,release_bundle}.py` | Signed manifest v2; local clean-checkout compatibility gate for a new candidate before bundle, Vercel, resource-limit, or host mutation; provider-independent durable resume/settlement; and byte-exact corpus inclusion in the closed immutable bundle for remote post-promotion/resume proof. Reuse the existing Android release workflow and asset upload unchanged. Consumes A read-only. |
| E — Integration | `docs/modules/player.md`; supersession notes in `android-native-player-pause-shortening-hard-cutover.md`, `durable-consumption-activity-hard-cutover.md`, and `immutable-production-release-hard-cutover.md`; residue audit and release evidence | Reconcile B–D, run broad gates once, publish in the required order. No owner logic. |

If a lane discovers a contract change, it stops and returns to A. It does not
edit another lane's files or add an adapter around the disagreement.

## Red → green → refactor

### Red

Before product changes, capture both failures:

1. Feed the captured published-v0.2.13 `Absent` reply to the web ingress. Target
   assertion expects Update Required with `/android` and no Retry; current code
   instead produces the generic invalid-response failure. Keep the red output,
   then replace the legacy body fixture with a minimal opaque noncurrent-
   identity case; no v1 body fixture remains in the green tree.
2. Run production preflight with a candidate v2 identity and absent/mismatched
   stable Android manifest. Target assertion requires a stop before the first
   mutation; current release path proceeds.

Record the failing commands/output. A newly written test that only passes is
not sensitivity evidence.

### Green

Implement A → B/C → D; make the focused owner proofs pass. Do not broaden the
wire, catch decoder defects, or mock the code responsible for classification.

### Refactor

Delete v1 constants, fixtures, parsers, generic TypeError-to-invalid-player
mapping, manifest-v1 acceptance, duplicate identity values, and newly orphaned
tests/styles. Search the entire repository for `protocolVersion: 1`,
`PLAYER_PROTOCOL_VERSION = 1`, `ANDROID_PLAYER_PROTOCOL_VERSION = 1`, the old
manifest shape, and the old invalid-response copy. Keep only unrelated protocol
versions whose owner is named by the match.

## Proof plan — one proof per ownership boundary

| Boundary / risk | Smallest proof and independent oracle |
|---|---|
| Web wire ingress | `androidPlayerProtocol.unit.test.ts` materializes A's corpus: exact v2 variants pass; a computed noncurrent identity with opaque body becomes the typed update error; matching-v2 corruption defects. Demonstrate red once with the captured old-APK reply, then delete that legacy body fixture. |
| Native wire ingress/egress | `PlayerProtocolTest.kt` consumes the same corpus: exact v2 variants round-trip; any noncurrent identity returns `ProtocolMismatch` without body parsing. `NexusPlaybackServiceContractTest.kt` proves both native consumers preserve the owned rejection code. |
| Player presentation | Real Chromium `GlobalPlayerSurfaces.browser.test.tsx`: install a narrow fake only at external `window.nexusPlayer`, mount the public providers, and prove Update copy/link/focus are visible while Retry is absent. One transient-unavailability case preserves Retry. `app/android/page.unit.test.tsx` renders the public update destination and proves its APK, checksum, and release links share the deploy controller's `releases/latest` owner. |
| Signed artifact | Existing `android-release` capability inspects the built, signed APK metadata and emits manifest v2 with the identical corpus identity. |
| Deploy coordination | Production-release kernel harness supplies a loopback GitHub boundary: the exact stable Android release behind `releases/latest` permits a new candidate; a non-Android/draft/prerelease/missing/malformed/skewed pointer or manifest stops before mutation; durable resume/settlement remains provider-independent. Do not contact GitHub in PR proof. |
| Production fact | Existing post-deploy version smoke requires source SHA and `/version.player_protocol` to equal the signed stable manifest. |
| One-user device fact | After deployment, the authorized operator installs the exact signed asset, confirms no Update banner, and performs one play/pause/seek/background/resume smoke. Record APK/version-manifest digests and production SHA. This is manual release evidence, not a repository test verdict. |

Register `android-player-protocol-skew` as a priority risk because it crosses an
independently released signed-native boundary. Add one deterministic fault that
bypasses the production identity comparison, and prove the registered test
rejects it:

```sh
./scripts/test prove --proof android-player-protocol-skew \
  --against fault:android-player-protocol-skew-bypass
```

## 80/20 verification

Run each expensive boundary once, through its repository owner:

1. During each lane: `./scripts/test changed <owned paths>`.
2. After B–D integrate: `./scripts/test confidence`.
3. Before merge: `./scripts/test pr` plus the registered fault proof.
4. For the tagged APK: `./scripts/test release`.
5. `./scripts/test nightly` owns only existing debug Android-device evidence;
   do not claim it installs the signed APK or contacts production.
6. After production: run the existing release controller's semantic/version
   smoke, then record the separately authorized manual device fact.

Do not add a protocol framework, Pact, full browser/device matrix, soak test,
or duplicate end-to-end wire suite. Focused/local, CI, signed-release, device,
and production evidence remain separately reported.

## Acceptance criteria

- **AC1 — Exact contract.** Every player message carries v2 plus the canonical
  digest; web and Android accept only the exact current body for that identity.
- **AC2 — Correct recovery.** Installed version skew renders Update with
  `/android` and no Retry. Updating to the compatible signed APK recovers
  without clearing workspace, app data, player data, or account state.
- **AC3 — Defect integrity.** Matching-identity malformed same-system data
  reaches the defect boundary; transient transport failure alone is retryable.
- **AC4 — Release prevention and recovery.** No new candidate's production
  mutation can begin unless GitHub's latest pointer names one stable signed APK whose
  identity equals the candidate. An existing durable attempt resumes or settles
  from its immutable bundle without a mutable provider dependency.
- **AC5 — Proven artifact.** Signed APK metadata, staged manifest, bridge
  envelopes, clean exact-SHA source, and production `/version` report one
  identity.
- **AC6 — Playback preservation.** The signed-device journey preserves current
  play, pause, seek, background/resume, session fencing, and activity sync. The
  device result is explicit manual release evidence, not `nightly` evidence.
- **AC7 — Sensitivity.** Both regression proofs are observed red before green;
  the priority-risk proof rejects its registered bypass fault.
- **AC8 — Clean cut.** Repository residue finds no v1 player path, manifest-v1
  acceptance, compatibility branch, duplicated digest, or obsolete retry copy.

## Non-goals

- Media3, audio source, queue, pause-shortening, activity, or offline-media
  redesign.
- Protocol negotiation, semver ranges, v1 decoder, dual bridge, fallback,
  phased rollout, or backward compatibility.
- Automatic updater, Play Store delivery, in-app APK installation, release
  channel framework, or multiple installed-client support.
- Database/backend API changes, telemetry platform, crash-reporting project,
  generic bridge schema generator, or unrelated dead-code cleanup.

## Done

Done means AC1–AC8 pass, the signed APK is published before web promotion, the
physical-device and production facts are recorded for the exact artifacts, and
the old paths are deleted. A green web test or a successful APK build alone is
not completion.
