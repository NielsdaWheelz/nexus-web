# server passage materialization drops captured context

source-derived gap at `c0acf77c3`; no runtime reproduction in this audit.

`python/nexus/services/resource_graph/links.py:50-73` captures and validates a
passage target, then passes only `evidence.quote.exact` to
`passage_anchors.materialize_or_reuse`, discarding the captured prefix/suffix.
chat creation still reaches this path (`chat/conversations.py:86-102`). server
source-identity lookup also reduces passages to owner plus exact text
(`search/pickers.py:215-218,263-273`). paths after the first are relative to
`python/nexus/services/`.

the anchor owner supports context (`passage_anchors.py:120-129,153-165`), but an
exact-only lookup refuses repeated text as ambiguous (`text_quote.py:188-205`).
thus a candidate whose precise occurrence is already known can fail to become
a durable link, even when its captured context distinguishes it. the read-side
identity lookup and write-side materialization must use the same proven selector.
browser authored linking already preserves owner, normalized exact, prefix and
suffix (`apps/web/src/lib/resourceGraph/links.ts:124-147`); this finding does not
apply to that path.

reproduce with two occurrences of the same passage text in one source, distinct
surrounding text, and a candidate captured at one exact extent. create a chat
with that candidate as context through the server path and inspect source-identity
lookup. verify the current refusal through the disposable runtime.

fix at the shared passage identity boundary: retain the captured quote/context
and validate it against the captured owner/extent before deriving the durable
anchor key. publication and locator prove validity, not semantic identity. do not
make stale offsets or ambiguous geometry authoritative.

resolved when either occurrence can be linked to its own stable anchor with
matching read/write identity, a stale captured publication refuses, and truly
indistinguishable passages remain explicitly ambiguous.
