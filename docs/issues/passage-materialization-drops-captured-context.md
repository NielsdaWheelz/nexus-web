# qualify contextual passage materialization

source repair is present; repeated-occurrence and stale-publication journeys
remain unqualified. the 2026-11-04 review at `b115cbce7` confirmed that
`python/nexus/services/resource_graph/links.py:72` passes exact text, prefix,
suffix and captured evidence to `passage_anchors.materialize_or_reuse`.
`search/pickers.py` uses the same contextual selector before deriving identity.

the historical exact-only path could reject a known occurrence as ambiguous
when its source contained repeated text. current ownership is in the
[resource-reference contract](../modules/resource-references.md); browser
authored linking was not affected by that server omission.

resolve by linking either of two context-distinguishable occurrences through
server chat-context creation and verifying matching read/write anchor identity.
a stale captured publication must refuse, and truly indistinguishable passages
must remain explicitly ambiguous. captured offsets alone do not prove identity.
