# profile updates have no version fence

`PATCH /me` accepts only absolute display-name/time-zone fields
(`python/nexus/schemas/user.py:35-48`) and writes them without an expected
version (`python/nexus/services/users.py:87-114`, integration e47819e34).
the settings form treats an identical retry as a no-op success, but a delayed
original request can still overwrite a later edit after that retry succeeds.

source counterexample: delay original value a before its transaction, let its
client lose the answer, replay a successfully, save b, then release the original
a. no server fence rejects that final stale write. this is an existing profile
protocol gap; preserving feedback's frozen unknown intent does not repair it.
no live reproduction was run during the feedback ownership audit.

give profile updates an explicit versioned absolute-write contract, with the
paired client/schema cut it requires. resolved when an independently delayed
original request cannot overwrite a later accepted version, including after
an uncertain retry. this is separate from feedback presentation.
