# the reader's serif names no face that android has

recorded 2026-11-17 at ef44ba92d, reviewing the notes redesign (the fair copy)
against the code. read in the source; not observed on a handset.

## problem

the serif reader profile is a stack of system faces: Iowan Old Style, Palatino
Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, then `serif`
(`apps/web/src/lib/reader/typography.ts:6`). android ships none of the named
ones, so the installed app falls through to the platform's generic serif.

## impact

reading matter already differs between the mac and the phone. once the notes
follow the reader profile (the fair copy, owner ruling 2026-11-17) the journal on
the owner's android handset will not be set in the face the design was drawn and
approved in.

## proposed fix

put a bundled serif in the stack ahead of `serif`. EB Garamond already ships
(`apps/web/src/app/fonts/eb-garamond-*.woff2`) but has a much smaller x-height than
Iowan, so the same size reads smaller; choosing the face is a design decision.

## resolved when

the serif profile resolves to a named, shipped face on android, or the owner
accepts the platform serif there and this file is deleted.
