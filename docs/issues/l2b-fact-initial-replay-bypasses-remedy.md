# server-fact initial removal bypasses held recovery

problem: the resource-row removal action is disabled only while running. after
an unknown it remains enabled; useFactRemovals.remove calls run(existing),
bypassing the unknown Hold's current shared remedy.

impact: the original remove action is a second replay entry under Update,
sign-in or offline even when the held recovery offers only another remedy or
a disabled resend. api refusal/guarded reload may prevent a server effect; it
does not satisfy the recovery contract. frozen command identity remains sound.

evidence: integration67a861c9d6e44ae73b9463373a90fe0d629719bc;
ResourceOutlineRow.tsx:287-294,355-358; useFactRemovals.tsx:105-113;
Feedback.tsx:239-251. source-only adjudication. existing unsettled includes
running or unknown, while the descriptor uses only busy.

resolve: disable initial removal while unsettled and make initial remove return
without dispatch for an existing running/unknown command. the exact owner-bound
Hold retry remains the sole replay path through shared remedy projection. keep
known-refusal retry behavior and local authored unlink separate.

proof: initial row command and frozen initial callbacks send nothing while unknown;
held recovery still retains immutable edge/context bytes and works once admitted.
no new guard/registry or read-triggered write.
