# a long desktop rail can scroll its open chip out of view

problem: round-1 press rail screenshot at d5c2a6a5f shows `more` focused and the
leading `open` label clipped. `Nexus.module.css` limits the rail to 70% width;
`NexusVerbRail.tsx:88-100` scrolls the focused chip into view, including when read
verbs insert before the initially focused `more`.

impact: the primary open hint can be partly hidden. focus remains pinned by id,
as required; changing initial focus after the read would violate that contract.

resolve through designer review of the bounded rail: accept horizontal overflow,
or adjust its geometry while retaining focus and the fixed pair. prove all chips
remain reachable at desktop widths and 200% text. screenshot location is private
`palette-shots/round-1/desktop-1440x900@2x-press-rail-on-armed-row.png`.
