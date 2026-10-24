# name-only contributor resolution silently picks the first person

problem: automatic contributor observations bind an unkeyed name to the earliest
person with a resolving alias, even when several distinct people share it.
name equality does not establish person identity.

evidence: `python/nexus/services/contributor_writes.py:142-157` orders matching
aliases by person creation and retains one winner; `:166-177` uses that winner
unless a handle, exact external key or conflicting same-authority key overrides
it. `python/nexus/services/metadata_enrichment.py:82-85` permits unbound research
names. source review only; no specific stored misattribution demonstrated.

impact: a source or research result for one namesake can appear on another
person's works page and author-filter results. removing manual editing also
removes explicit distinct-person creation as a user workaround; an unbound
research name goes through the same resolver and cannot request that distinction.

resolve at the contributor identity owner with an explicit contract for ambiguous
name-only observations. a shared name may identify candidates; it must not choose
between known distinct people by creation time. preserve the observed credit
without asserting unsupported identity; do not substitute fuzzy matching or
automatic person merges. `python/nexus/db/models.py:504` requires a person on
each stored credit, so ambiguity needs an explicit unresolved outcome or refused
publication, rather than an invented binding or an invalid-model-output label.
representation and existing-data repair need a separate bounded design from
deleting the editor.

resolved when observations for two known namesakes cannot silently bind to the
first, supported handles/keys still resolve deterministically, and an ambiguous
observation has a defined outcome without losing unrelated credits.
