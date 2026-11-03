# connection scan loses unanswered intent when its surface retires

problem: ConnectionsSurface's useDiscoveryScan keeps phase/held only in local
react state. changing the inspector tab or retiring its body loses an unanswered
start and its recovery. passive idle/null status also clears that uncertainty
without proving the timed-out request cannot commit.

evidence at14400e332: `apps/web/src/components/connections/ConnectionsSurface.tsx`
110-126 owns local state and unconditional passive settlement; `Companion.tsx`
mounts only the active tab body. WorkspaceHost keys actual source bodies; no
cross-resource callback retargeting claim follows merely from this local-state gap.

fix with the existing visit resource draft and WorkGuard in ConnectionsSurface,
retaining the exact selfRef/command and current account/visit/record fences.
reopening must restore recovery. passive stale/terminal observations and refused
replay cannot erase uncertainty; a direct accepted retry answers that attempt.
no global recovery registry or new companion owner is needed.

resolved when: real tab/body retirement restores exact unknown recovery on reopen,
refused retry/idle read retain it, actual accepted retry settles its acknowledged
attempt, and retired callbacks cannot dispatch against another owner.
