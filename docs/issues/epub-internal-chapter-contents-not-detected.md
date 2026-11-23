# embedded chapter contents are omitted from epub navigation

status: implementation and lab verified. production repair pending.
origin: 2026-11-21 norton moby-dick investigation, main `06419a76d`

production media `39cc0b8a-20f0-40e5-a7df-960a27c22f3e`, publisher
`W. W. Norton & Company`, has 49 fragments and 130 reading sections. the novel
starts at fragment 16; its sole section is `Moby-Dick`. none of its 135 chapters
or epilogue has a section. the later `“Loomings”: Yarns and Figures in the Fabric`
entry names a critical essay. original size is 4,074,452 bytes, sha256
`a3c67617a631796b34564bc09a8312b3e0f31c1ac2067562ff8fbb38d9c12e17`.

the epub 2 ncx supplies 130 entries, including a childless `Contents of
Moby-Dick` destination at `text/part0011.html`. that html page supplies 135
numbered chapter links plus epilogue. all 136 targets are unique, ordered and
reciprocal to the corresponding index entry. chapter numbers agree with each
destination's `CHAPTER n` label. the ten novel files use linked paragraphs for
chapter numbers and titles; the complete spine has no `h1`–`h6`.

twenty index titles differ from body titles even after normalization. chapter
100 is `The Pequod meets the Samuel Enderby of London` in the index and
`LEG AND ARM` in the body. chapter 41's designation paragraph also contains
a note marker, so its combined text is `CHAPTER 411`; its designation anchor
correctly says `CHAPTER 41`. links and designation anchors establish identity;
whole-paragraph text or title equality would reject valid destinations.

`python/nexus/services/epub_structure.py:315` examines internal links only to
recognize contents already corroborated by package toc entries. it emits no
new destinations from embedded contents. `:425` and `:592` admit package toc
and html headings; the numbered-incipit rule at `:1056` does not cover this
source. no apparatus classification caused this omission: both stored and
fresh imports have zero note groups/items. source diagnostics are empty.

fresh main import reproduces 130 sections. rederivation from the exact installed
canonical bodies reproduces their 130 ids and starts and still omits the chapters.
in a disposable counterfactual, admitting the 136 internal links recovers them
all, including chapter 1 at `16:0` and chapter 3 at `16:28838`. blindly treating
them as peer sections incorrectly ends `Moby-Dick` at chapter 2 (`16:18684`).
the novel and chapter 1 have the same text point but different rich arrivals.
`epub_structure.py:1169` also treats any section as evidence that a spine file
is indexed. adding arrival-only sections must not remove unproved spine
boundaries or make them peers in range inference.

resolve by recognizing independently evidenced embedded contents, reconciling
their chapter boundaries with existing publisher destinations, and establishing
ownership before assigning ranges. unknown parents/ends remain null. validate
ordered labels, unique reciprocal targets and chapter/title grouping; exclude
the contents page's framing and footnote links. retained anchors/links already
carry the necessary evidence, so this repair need not rewrite canonical text.

acceptance: all 135 chapters and epilogue are navigable once, the whole-work
destination remains correct, and ordinary/hosted contents agree. review the
complete navigation-only proposal before applying: baseline main also removes
18 stored parent relationships and eight extents and adds previously absent rich
cuts on this edition. preserve text, fragment ids, authored references and reader
positions; verify actual ends against the edition's interleaved editorial notes.
no production repair has been performed.
