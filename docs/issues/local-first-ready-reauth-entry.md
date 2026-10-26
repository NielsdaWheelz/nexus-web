# ready account has no reauthentication action

on `fb125c4bc`, a provisioned workspace remains editable after credentials
expire, but its account menu exposes only passive sync status. the preparing
provider and unbound device shell have sign-in actions; neither is rendered
once the local corpus is ready. android's public `nexus://auth/start` entry
exists but is not a workspace affordance.

the account menu now offers the existing sign-in flow when its status is
`sign_in_required`. it neither signs out nor replaces local writing. static
and live qualification remain pending.

resolve after real credential removal yields the sign-in action on a ready
corpus; same-account authentication must preserve account, replica, exact rich
writing and pending source prefix, then upload without another semantic touch.
include the installed handoff. cancellation and another account must not purge
or replace the bound account.
