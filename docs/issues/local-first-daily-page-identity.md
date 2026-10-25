# offline daily pages need convergent identity

target gap: two disconnected devices must be able to create today's page and
combine automatically, including after a prior page for that date was deleted.

evidence: `python/nexus/services/notes.py:285-318` proposes a random id and refuses
a competing live daily binding with `This day has a different page`.
`:264-272` retires the identity, removes the date binding and deletes the page.
`python/nexus/services/authored_identities.py:103-118` makes retirement permanent.

impact: persisting current commands does not supply automatic daily-page merge.
a stable date identity alone also needs defined deletion/recreation semantics.

resolved when disconnected first-use and delete/recreate/concurrent-edit cases
yield one visible daily page with the retained authored content and convergent
references, without manual conflict resolution.
