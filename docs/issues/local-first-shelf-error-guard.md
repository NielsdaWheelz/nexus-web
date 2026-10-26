# preserve shelf guard above the integrated error boundary

integration hazard, not a reproduced shelf failure. candidate `eddb6c474` changes
`AuthenticatedWorkspaceErrorBoundary.tsx`'s stopped fallback to require
`useWorkGuard()` for retained copy text. root's `shelf/main.tsx` mounts that
boundary in `ShelfAccountScope`, above the annotation-only `WorkProvider` in
`shelf/ShelfReader.tsx`. importing the fallback without adapting this composition
would make a shelf render failure throw again: `useWorkGuard requires WorkProvider`.

hoist the single shelf `WorkProvider` into `ShelfAccountScope`, outside its
existing unconditional boundary; remove the annotation layer's duplicate.
keep the provider and boundary mounted during loading/ready/unavailable account
states so account discovery cannot remount or gate the source reader. do not key
them by loading-versus-ready account state. native document/account retirement
owns replacement; the boundary receives the actual ready account id as today.
the annotation `AuthoredProvider` remains behind its existing ready-account gate.

resolve after this composition is integrated and independently reviewed, with
the existing source-open and annotation/loss-guard qualification preserved.
do not add an optional guard fallback or claim a forced render failure was tested.
