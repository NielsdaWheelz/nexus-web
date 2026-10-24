# nexus capture

`manifest.json` and the icons own the firefox package. the client implementation
is `apps/web/src/extension`; `apps/web/scripts/build-extension.mjs` builds the
unsigned payload with explicit nexus and storage origins.

## signed self-distribution

use the verified native-client release zip and its source/wire provenance.
keep `capture@nexus.local` stable: firefox storage and the identity redirect
origin depend on it. every changed package needs a new extension version;
mozilla already holds `1.0.0` for production wire 14. signing main's wire-15
client does not make it compatible with that production release.

mozilla developer credentials belong in
`~/.config/fleet-security/mozilla-signing.env`, mode `0600`, as
`WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`. the signing tool is installed in a
private directory; credentials go through its environment, never arguments or
debug output. use a fresh input directory for a new version.

with the qualified zip unpacked into `NEXUS_FIREFOX_INPUT` and its reviewer
source zip at `NEXUS_FIREFOX_SOURCE_ARCHIVE`, sign through the native tool:

```sh
(
  set -a
  . "$HOME/.config/fleet-security/mozilla-signing.env"
  set +a
  "$HOME/.config/fleet-security/firefox-install/tools/web-ext-10.8.0/node_modules/.bin/web-ext" sign \
    --channel unlisted --no-config-discovery \
    --source-dir "$NEXUS_FIREFOX_INPUT" \
    --upload-source-code "$NEXUS_FIREFOX_SOURCE_ARCHIVE" \
    --artifacts-dir "$HOME/.config/fleet-security/firefox-install/signed"
)
```

the reviewer source includes the qualified commit, locked dependencies and
build instructions with the public nexus/storage origin pins. check the
owner's existing unlisted version before submitting; reuse an identical signed
payload. wait for mozilla approval and download the signed xpi.

compare signed members against the verified unsigned payload, excluding
`META-INF` signatures. web-ext 10.8.0 removes the manifest's final newline;
accept that exact normalization only when the parsed manifests are equal and
every other member hash matches. do not modify a signed package.

open the signed xpi in normal firefox, accept its declared data permissions,
then connect to nexus and complete a disposable capture. verify persistent
signed installation; temporary debugging installation is not distribution.

the remaining [client-release integration](../../docs/issues/release-firefox-signing.md)
must couple this signed artifact to future qualified native-client releases.
