# epub source ordinal wrapper has no caller

status: open. origin: 2026-10-04 structural source audit at `f9c35967`; area: epub reads.

`python/nexus/services/epub_read.py:105–112` exposes
`get_epub_fragment_source` without a tracked caller, decorator or registry entry.
the repository-wide symbol read finds only its definition. public sharing calls
`list_epub_fragment_sources` (`public_resource_sharing.py:128`); the reader route
calls `get_epub_fragment_for_viewer` (`api/routes/reader.py:56`). the unused
ordinal wrapper adds an unnecessary public form of the read.

recheck current code, cli and release callers, then delete only this wrapper.
retain the shared list/query, source content type and authorized reader path.
acceptance: no remaining wrapper references and `./scripts/test` passes.
no runtime or data deletion is proposed.
