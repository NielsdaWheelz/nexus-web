# saved first-publication dates need repair

status: open; local contract qualified, saved-production repair blocked
origin: 2026-10-01 owner clarification
area: bibliographic date meaning

2026-10-03 utc: prompt, schemas and module docs implement the clarified rule.
final `bcdaf51de` ordinary live jobs independently qualify *mere christianity*
(1952), *of other worlds* (1966) and the standalone *weight of glory* essay
(1941-11), with supported precision, edition separation and original stock
luna/xhigh/four-tool evidence. see
[verification](../metadata-enrichment-verification.md). targeted saved-production
correction remains NOT_RUN behind the historical uncertainty/release gate.
the evidence below is baseline.

baseline problem: `python/nexus/services/metadata_enrichment.py:52–57` and
`docs/modules/media-metadata.md:8–10` count serialization as original publication.
the clarified requirement is first book publication for books and collections;
earlier broadcasts, lectures and serialization do not establish that date.
individual essays use their own first publication, including periodicals.

fix: update the metadata prompt and owning documentation together under
`../metadata-enrichment-plan.md`. retain current date precision and separate
edition date. determine the saved item's identity before applying the rule.
existing stored dates under the old meaning need ordinary targeted re-enrichment
after runtime recovery, not an unconditional date rewrite.

acceptance: a serialized-then-book work gets first book publication, a collection
gets its own book date, and an individual essay gets its own first publication.
delivery/broadcast dates and modern reprint dates do not replace those facts.
inspect targeted saved-item corrections after the separately authorized aligned
release; preserve original uncertainty and never rewrite dates unconditionally.
