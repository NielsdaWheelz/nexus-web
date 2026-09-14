status: open
origin: 2026-09-13 bounded workspace native archive review
area: offline package validation / memory

`apps/android/app/src/main/java/app/nexus/android/offline/reading/OfflineReadingPackageVerifier.kt:185`
reads an allowed 8 mib SVG into bytes and a UTF-8 string, then builds a complete
XML DOM and enumerates every element. encoded bytes do not bound expanded node
allocation. this is a source-level finding, not an observed memory kill.

replace only structural validation with the platform streaming XML parser;
retain no-DTD/entity/network rules, root/element/attribute policy and exact
namespace treatment. qualify the maximum supported dense SVG and preserve
shared valid/invalid archive decisions. coordinate normalized SVG paint syntax
with the publication owner; do not add a second permissive sanitizer.

acceptance: actual native parser traverses the full maximum asset with bounded
live state, rejects the existing external-resource cases, and verifies both
legacy migration input and schema-2 assets without whole-tree construction.

staged fix: streaming SAX with the existing byte-level declaration policy.
`563e55b01a8c87b2` on native checkpoint `6b58460f73` passes the exact 8 mib dense
asset, late executable node, namespaces, malformed XML, and UTF-16 DTD cases;
disabling the DTD guard fails the oracle. device memory qualification and the
final shared-corpus/native release lanes remain open.
