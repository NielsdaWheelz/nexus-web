# first-publication semantics need live qualification

status: open
origin: 2026-10-01 owner clarification
area: bibliographic date meaning

2026-10-02 candidate: prompt and module docs implement the clarified rule;
strict date precision and edition separation pass local checks. actual model
judgments and targeted saved-item correction remain NOT_RUN. finish the finite
live fixtures after qualified native integration. the evidence below is baseline.

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
