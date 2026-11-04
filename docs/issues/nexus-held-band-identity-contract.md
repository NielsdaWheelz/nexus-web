# nexus held-band identity contract

the palette specification models `NexusList.held` as a prefix count. law 1 also
requires a newly arriving latch before already held rows. a prefix cannot retain
the new latch’s arrival onset and the surviving held/arriving classifications.

`lib/nexus/model.ts` now represents held membership as readonly row keys.
`list.ts`, the controller’s blank initializer, and both desktop and sheet
presenters consume that shape. a full list admits the latch first and drops its
last non-armed row, preserving the armed identity, eight-row cap and survivor
order. no ordinary arrival moves a shown row.

this is an explicit specification api deviation pending owner review. resolve by
accepting key-based membership in the contract, or supplying a representation
that preserves both the latched exception and the existing onset laws. the
pipeline and both rendered surfaces must retain those behaviors.
