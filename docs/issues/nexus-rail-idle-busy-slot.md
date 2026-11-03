# nexus rail reserves an idle busy cell

`apps/web/src/components/nexus/NexusVerbRail.tsx:190` always mounts `railBusy`,
including when `busy` is false. `Nexus.module.css:123` gives it a 28px flex basis.
the empty cell consumes rail width and contradicts feedback's no-idle-reservation
rule. main introduced this rail in `ca357365b`; merge preserves its behavior until
the final feedback cut.

L7 should remove `reserveIcon` and `busyKey` there and paint a pending read in an
existing control or overlay without an idle slot. resolved when the idle rail has
no busy cell and a settling read cannot move a held verb.
