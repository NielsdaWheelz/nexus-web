# a phone-width send press is lost when the mini player returns

status: open
origin: 2026-11-02 feedback-homes l3 lab probe
area: web / mobile shell / player

at phone width the mini player hides while a root text field has focus, unless a native
keyboard is known absent (`components/player/GlobalPlayerSurfaces.tsx:355`, fed by
`useRootTextEntryFocused`, `lib/mobileShell/viewport.tsx:310`). pressing chat's send blurs
the composer's textarea on mousedown; the bar returns and the composer moves up 64px before
mouseup, so the click lands on `div.app-viewport` and never reaches send.

impact: in a new chat at 390px, a mouse press on send does nothing: no request, no busy
state, no refusal. any control under a focused root text field that the returning bar
displaces loses its first press the same way. real touch is unverified: whether a tap's
click retargets after the shift is the android emulator's to show.

evidence, chromium, lab, 390x844, mouse (probe at feedback-homes-l3 `9adf14d45` plus the
deadline commit): `capture mousedown target=path send=325,723`, `capture focusout
target=textarea[ask anything]`, `capture mouseup target=svg send=325,659`, `capture click
target=div.app-viewport`; zero `POST /api/chat-runs` after 3s and after 38s. the same probe
at 1280x900 posts at once. the l3 phone journey raises its held send at desktop width and
narrows after, to step around this.

reproduce: open `/conversations/new` at 390x844 with a mouse, type, press send.

resolved when: a press on send at phone width posts the first time, with the composer
focused, in chromium and firefox, and on the emulator by tap.

current repair: `GlobalPlayerSurfaces.tsx:323-338` defers the mini-player return
until the initiating pointer gesture's click task finishes. phase-two l5b
`67548eee0` introduced that ownership; l3's current browser proof sends the first
and second messages at phone width, using chromium touch and firefox's narrow
screen handler path. the old desktop-send-then-narrow workaround no longer
qualifies this case. actual emulator tap with the keyboard and player remains
the final unresolved part of this record.
