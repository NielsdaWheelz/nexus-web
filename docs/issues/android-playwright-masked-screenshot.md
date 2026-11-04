# masked screenshots require unavailable native webview methods

on source `c7c412c8`, owned api34 run
`20261103-171902-d683287d1f23` completed both real sign-in handoffs and their
durable-account and remote-identity assertions. the following masked page
screenshot failed with `this._glassPaneElement.hidePopover is not a function`,
before playback or the four remaining native journeys. exact device and
canonical runtime cleanup completed normally.

the installed playwright-core 1.64.1 mask path in `lib/coreBundle.js` calls
`addMaskedElements`, installs its highlight, then calls `hidePopover` and
`showPopover` without a capability guard. the actual webview was
113.0.5672.136. a selector with no matches skips that callback; this does not
establish that every screenshot fails, or that dependencies changed.

impact: a matched screenshot mask can stop native qualification after a
successful application action. post-authentication evidence can use the
existing owned-device screenshot and sanitized accessibility snapshot without
changing application behavior or browser capabilities. retain the failed page
capture as a tooling limitation. resolve when matched masks work with the
supported native webview, without exposing credentials or changing product
state to manufacture a passing image.
