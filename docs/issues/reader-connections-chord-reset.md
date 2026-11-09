# reader connections chord can reset during chrome updates

the `g e` pending timer lives inside the keyboard effect in
`apps/web/src/app/(authenticated)/media/[id]/chrome.tsx:149-193`. cleanup clears it;
dependencies include media title and focus mode. a dependency change between the
two keys can therefore discard the chord. this is source inference, not a
confirmed causal reproduction.

outline run `20261108-220124-531e5471b8e7` failed before the resource-list host
appeared after the chord; the reader remained open with inspector closed and no
pane error. its private trace retains the sequence. the outline host is qualified
through the existing inspector and connections controls separately.

reproduce by changing a keyboard-effect dependency between `g` and `e` within
the chord interval. resolved when the same pane retains the pending chord across
irrelevant chrome updates and revokes it when its owning visit becomes inactive.
