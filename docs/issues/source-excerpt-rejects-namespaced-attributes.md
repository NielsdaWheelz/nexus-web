# source excerpt rejects namespaced attributes

status: open.
origin: 2026-11-01 connections-scroll proof corpus.
area: python source excerpts.

problem: `python/nexus/services/source_excerpt.py:404` clones each source element as
`Element(node.tag, dict(node.attrib))`. `lxml.etree.Element` refuses an attribute name with a
namespace prefix written literally, so any excerpt whose window crosses an element carrying
`xml:lang` (or another prefixed name) raises
`ValueError: Invalid attribute name 'xml:lang'`.

impact: standard ebooks epubs mark greek and latin words with `xml:lang`; the meditations epub
in the connections-scroll corpus carries it 84 times (`el` 72, `la` 12). every caller of
`source_excerpts` fails on such a passage: resource item evidence
(`resource_items/evidence.py:288`), search projection (`search/project.py:277`) and tool writes
(`tools/writes.py:406`).

evidence: seeding highlights on that book through `source_excerpts` raised the error above; the
lab seed (`apps/web/.nexus-lab/cases/seed_highlights.py`, ignored) strips colon names in its own
process only, so the running server keeps the defect.

reproduce: import standard ebooks' meditations, then request a source excerpt over a passage
containing a greek word (any `<span xml:lang="el">`).

resolved when: an excerpt across `xml:lang` returns, with the language kept as `lang` or the
attribute dropped deliberately, and the three callers above read such a passage.
