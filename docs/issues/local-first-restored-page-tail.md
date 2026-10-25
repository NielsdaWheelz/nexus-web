# restored page append placement

when a server command restores a hidden page and appends its first new note in one batch, the old tail query filtered out all retained links using projected endpoint visibility. a meaningful real-postgres case in the retained `backend_cutover.py` produced old positions `a0`, `a1`, then new position `a0`; the new note could precede old children.

the owner query now ignores the requested root's current visibility, retains canonical link membership and opposite-endpoint liveness, and reads bounded indexed tails per arm. awaiting the exact real-postgres green rerun plus hidden-opposite-endpoint variant. remove this issue when both pass; retain the cases until final canonical proof.
