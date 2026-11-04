# browser chrome history shortcut remains unverified

the headless chromium and firefox keyboard drivers do not execute `Meta+[` as browser back, even with body focus and a real two-entry same-document history. the focused rail produces the same result and no audio seek. this proves neither physical browser-chrome shortcut execution nor its preservation.

evidence: lab `20261102-202713-c66b383c7eb6`, `l6-keys.spec.ts` modified-navigation journeys. each `browser-history-command.json` records `railHistory` and `pageHistory` as `#l6-forward` and `acceleratorObserved: false`. the separate 54-chord matrices check actual audio position, restored native range value and unprevented navigation events, including modified home/end; those pass in both engines.

the product guard is local to the rail's native input and never prevents these browser-owned keys. actual browser-chrome history execution requires an explicitly authorized verification surface that sends those accelerators; no installed or visible browser is authorized for this lane. resolved when that real command is observed with rail focus and leaves playback position unchanged.

installed-input qualification belongs to [the paired playback release](release-playback-bar.md).
