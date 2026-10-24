# search evidence repeats credit names

problem: a title search can show repeated publisher/credit names beneath the
canonical identity, even when those names do not match the query. this obscures
why the result matched.

reproduce: import project gutenberg's persuasion; search for `Persuasion` in
resources. the identity shows jane austen once, then evidence shows her name
three times. a planet money episode similarly shows `NPR NPR NPR` after its
description. observed on `e4820bc6d`, real lab `20261021-222707-d7d32e4e16ef`.

owner: `python/nexus/services/search/sources.py:101` concatenates description,
publisher and contributor search text into display evidence; `presentation.py`
excerpts it. `apps/web/src/components/resources/ResourceOutlineRow.tsx:980`
renders that evidence separately from canonical media identity.

resolved when: real title and contributor queries show nonredundant, relevant
evidence while preserving ranking, legitimate contributor matches and nested
passage provenance. search-evidence policy is outside the media-controls cut.
