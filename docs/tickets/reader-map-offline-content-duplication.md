# offline epub content is serialized once per navigation target

status: open
origin: 2026-09-11 reader-map implementation-spec review
area: offline publication contract

`python/nexus/services/offline_reading_delivery.py:302-353` writes full
sanitized html and canonical text per navigation entry, although rendering is
cached per fragment. adding missing headings therefore multiplies identical
content in `reader.json` and can breach its 64 mib limit. the publication
capture already carries unique fragments separately from navigation.

prerequisites: finalize the new shared navigation/fragment schema before
enabling finer heading extraction.

proposed fix: hard-cut the offline reader payload to unique canonical fragments
plus navigation metadata. decode that single shape across python, typescript,
and kotlin; load targets by fragment reference. retain existing package limits.

acceptance: one long fragment with hundreds of headings is serialized once;
adding headings grows only structure metadata. hosted/offline target resolution
agrees, and obsolete per-target-content packages are rejected by the new
contract without discarding pending reading progress.
