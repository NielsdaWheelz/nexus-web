# concurrent offline annotations lack an automatic merge contract

target gap: independent devices can annotate the same source extent while
offline. automatic synchronization must preserve both contributions.

evidence: `python/nexus/services/highlights.py:877-890` aliases an exact-extent
highlight to one canonical identity, then refuses a different initial note id
with `Highlight already has a note`.

impact: the current server conflict policy cannot meet always-automatic merge.
the owner selected independent linked notes for concurrent annotations, not one
merged annotation identity. highlight identity and source-version anchoring need
a convergent contract while both note identities and bodies remain intact;
blindly replaying existing requests is not offline annotation support.

resolved when both text and pdf same-extent offline annotations converge with
all authored text and links retained, including reversed delivery order and a
changed source publication. no manual recovery destination is introduced.

owner also confirmed retaining pdf resizing with stable independent highlight
ids. remove exact-extent creation aliases and duplicate-resize refusal
(`python/nexus/services/pdf_highlights.py:134-184`); overlapping highlights may
coexist, each retaining its own notes. verify resize preserves identity and
deleting one overlap leaves the other untouched.
