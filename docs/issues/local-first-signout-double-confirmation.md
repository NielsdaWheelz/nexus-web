# failed local writing receives two sign-out confirmations

central authored-runtime registration makes `WorkGuard.signOut` warn for a local
saving/error snapshot. its callback then reaches `prepareAuthoredSignOut`, which
asks its own explicit all-tab discard question. both decisions protect the same
failed input; ordinary durable offline pending writing does not trigger the
first warning.

evidence: `unsavedWork.tsx` signOut calls confirmDocumentExit before purge;
`AccountMenu.tsx` supplies prepareAuthoredSignOut in that purge;
`authored/signOut.ts` confirms unfinished writing/all-tab browser discard.

preserve explicit all-tab discard and independent upload/acquisition loss
warnings while choosing one owner for authored input confirmation. prove with
actual failed typing → sign out: one complete warning, cancel keeps input, accept
removes device writing deliberately. no live double-prompt claim yet.

implemented one decision owner: registry signOut now supplies its existing risk
confirmation callback to the purge callback. prepareAuthoredSignOut invokes it
once after freezing/preparing its accepted prefix, with its authored/all-tab
message or null. the callback combines current work risks into that one dialog.
ordinary exit/reload registration is unchanged; decline still unwinds the
existing signout operation and resumes paused preparation. actual qualification
is pending.
