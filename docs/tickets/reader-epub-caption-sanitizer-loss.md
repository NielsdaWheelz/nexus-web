# epub caption semantics are discarded

status: open; source inspection, actual producer reproduction pending.
origin: 2026-09-14 bounded workspace publication review.
area: epub sanitization / table source context.

`python/nexus/services/epub_ingest.py:182` omits `caption` from
`_EPUB_ALLOWED_HTML_TAGS`. `_sanitize_epub_element` at line 2095 unwraps
unknown elements, or turns an authored id into a span. either path removes
the caption relation before the table publisher can retain it. the web caption
fix does not cover this separate sanitizer.

reproduce through actual epub extraction and publication, then preserve the safe
caption element in the existing allowlist. retain original bytes and the current
html5 normalization. do not infer captions in previously sanitized sources.

acceptance: observed source-producer red/green proves caption text, authored id,
exact original range and sparse table metadata survive a real epub; current
header/normalization oracles remain green.

actual stored-source preparation red `58f65f6f1291df22` reaches the missing-caption
assertion. adding only `caption` to the existing allowlist yields green
`940b798f8a9a3b7a`: exact original `(4,16)` caption range, rendered element,
authored anchor at codepoint 4, member digest/length and unchanged source bytes.
canonical registered fault replay remains pending.
