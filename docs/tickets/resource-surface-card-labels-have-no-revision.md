status: open
origin: 2026-09-26 notes bullets pr 2 adversarial cache review
area: resource surface card metadata

non-note cards expose a `links` version but no version for their label and
summary (`python/nexus/services/resource_items/surfaces.py:751-755`). two
concurrent surface reads can return different card text at the same version;
the client cannot prove which text is newer. the bullets cache keeps the current
presentation when an incoming lane is older, but equal-version ordering remains
ambiguous. a renamed card can briefly show an older label after a delayed read.

prerequisite: define a canonical metadata revision for non-note resource cards.
include it in surface item versions and use it to choose card presentation when
accepting concurrent reads. do not use the link version as a proxy for text.

acceptance: a delayed old surface response after a card rename cannot replace
the new label or summary, while link ordering and versions remain correct.
