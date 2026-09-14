status: open
origin: 2026-09-13 bounded-workspace implementation review
area: retained publication / whole-word find / native migration

the publisher now uses the existing pinned worker Node runtime and
`Intl.Segmenter("und", { granularity: "word" })`, with original-fragment input
and staged uint32 codepoint output. regex dictionary regression red
`f6f9e9550b217028`; dictionary/splitter corpus green `656fbb3131af91bb`.
local proof runtime is Node24.21.0/ICU78.3; deployment remains pinned Node22.23.2.
this is an algorithm-family match, not a cross-version identity claim.

native Find remains unavailable by the existing product contract. local
conversion explicitly writes null boundary metadata; hosted preparation/install
reject null. computing a native dictionary engine is outside that capability.

remaining: characterize the actual browser against the independently reviewed
Thai/Chinese/Japanese corpus plus Lao/Khmer, punctuation, format/combining/astral
points and cuts. qualify the exact pinned worker image on maximum unbroken CJK;
ICU may allocate for the complete dictionary span despite staged I/O. no invented
worker memory or time limit is accepted as qualification.

acceptance: browser and exact producer preserve supported whole-word outcomes;
record runtime/ICU versions and measured worker/host peak, latency and source
bounds. canonical IDs and coordinates remain unchanged.
