status: open
origin: 2026-09-14 full native host preparation
area: native progress-choice proof after schema-two ingress

`OfflineReadingProgressChoiceTest.kt:77` still corrupts a file named
`reader.json`. its actual `buildWebArticleReadingPackage` now produces
`units/intro.json`, `index/0.json` and `descriptor.json`
(`src/sharedTest/.../OfflineReadingTestPackages.kt:121–162`). the fixture
therefore cannot reach its corruption/replacement/preserved-intent oracle.
this is a source inspection finding; no failing execution is claimed yet.

observe the actual owner, then corrupt its addressed schema-two unit member.
preserve the real store/archive preparation, generation transition, exact
pending identity/source and explicit resolution checks.

acceptance: actual owner reaches its original durable progress-choice assertions
with schema-two source bytes; final full native host includes it.
