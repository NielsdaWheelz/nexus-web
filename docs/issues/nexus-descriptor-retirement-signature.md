# descriptor activation needs a retirement callback beyond the palette sketch

problem: the palette specification sketches a three-argument `activateDescriptor`.
`lib/ui/actionDescriptor.ts:33-44` takes a fourth `retire` callback and flushes
presenter closure before a command opens another focus owner.

impact: the implemented api differs from the sketch; removing the callback without
preserving that ordering can let rail focus restoration steal focus from a dialog.
this is an intentional implementation constraint, not an observed runtime defect.

resolved when the module contract and owner review explicitly accept the callback,
or an equally ordered activation contract replaces it. exercise show excerpt and
a descriptor opening a confirmation before changing the sequence.
