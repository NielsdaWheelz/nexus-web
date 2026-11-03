# share capture submitted work guard

status: source repaired; native exit verification pending.

the old card's separate url/destination acquisition could outlive an unguarded
exit. `app/share/ShareCapture.tsx` now mounts the existing `ImportIntakeProvider`
under `WorkProvider`, with no destination creator or independent send queue.
`lib/imports/intake.tsx` registers sending, verifying, unknown and browser work;
the plain capture retains its separate submitted-work guard and authored owner.

resolved when an actual native card exit during in-flight and uncertain imports
offers the existing stay/leave decision, honours both choices, and stops blocking
after acknowledgement. accepted server work must survive a confirmed exit.
source composition and a static gate alone do not establish this device boundary.
