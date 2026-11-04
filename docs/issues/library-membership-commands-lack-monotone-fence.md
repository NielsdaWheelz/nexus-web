# membership commands have no monotone concurrency fence

role changes compare `expected_role`, and ownership transfer checks the current
owner. those values can return to an earlier value. a still-running old command
can therefore apply after a newer opposite command, despite an intervening read
or accepted replay showing its desired state.

source evidence at feedback-homes72cf9db84: `python/nexus/services/library_members.py`
97-136 compares roles and retries serializable attempts;170-202 checks current
ownership and retries. `python/nexus/schemas/library_members.py:17-25` carries no
monotone revision, although its docstring calls the role a version.
`python/nexus/db/retries.py:93-136` retries against fresh snapshots.

example: an unanswered member→admin command remains active; another attempt
makes admin, then a newer acknowledged admin→member command restores member.
the old command's fresh transaction can again satisfy expected_role=member.
transfer away and back has the same shape. this schedule is source-supported,
not a reproduced concurrency failure.

feedback retains exact command bytes and guards uncertainty, but a desired-state
read establishes only that current state; an accepted replay establishes only
that request's acceptance. neither proves every earlier request permanently
unable to act. delaying or repeating a read cannot supply that missing authority.

resolve at the membership/ownership writer with a monotone version contract,
updating all producers/consumers together and qualifying the delayed-original,
opposite-command, return-to-original-value schedule. no replay ledger is needed.
this wire/schema correction is outside feedback homes' explicit non-goals and
remains separate from its presentation repair.
