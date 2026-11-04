# workspace-error playback needs live qualification

source corrected in `c3ea34e5c`: `AuthenticatedShell.tsx` keeps the player root
above workspace error containment. `GlobalPlayerSurfaces.tsx` keeps `PlayerKeys`,
`PlayerOriginObserver`, announcements and outcomes there too. the observer in
`usePlayerOrigin.ts` settles and retires marks independently of visual rules;
the root and keyboard owner stay off the clock.

the remaining gap is live qualification with the workspace fallback actually
showing while audio survives. no admitted trigger was available. ordinary
seek/keyboard passes and source ownership establish narrower evidence; they do
not meet this record’s original live acceptance. a failure here would leave no
visible player controls and could also strand return-to marks.

resolve when a real workspace failure with a non-editing target demonstrates
that space/k pauses surviving audio, chapter-key seeks still settle marks,
apostrophe returns/swaps after landing, and crossing/five media minutes retire
the mark. retain ordinary edit/interaction-owner guards during that observation.
