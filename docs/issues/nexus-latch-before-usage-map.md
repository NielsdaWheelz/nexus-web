# a query typed before the first usage map cannot latch synchronously

problem: on the first open, the usage map may still be loading when a query paints.
`useNexusController.ts` computes `latched` only from `find.usage`; the list shape
excludes usage arrival. a subsequently loaded map does not rebuild synchronous
candidates, so an already shown pane or recent target cannot gain its latch until
the next keystroke.

impact: the first query of a cold session can arm differently from later opens.
reproduce by delaying `/api/me/nexus-ranking`, opening nexus, and typing a learned
prefix before releasing the response. evidence: `useNexusController.ts:291-324`
and `useNexusFind.ts:76-91`.

resolution needs a policy for cold memory that preserves immediate opening and
no movement after the query paints. do not rerank on map arrival. resolved when
a delayed first usage map has an explicit documented arming contract and the
cold-open journey proves it.
