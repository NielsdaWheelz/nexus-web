# android lab keyboard baseline has ambiguous evidence

the private native qualification predicate matches `mInputShown=true` or
`mIsInputViewShown=true` anywhere in `dumpsys input_method`. it retains only a
boolean, so it cannot identify the matching field, section or current window.
this can block a later modal check without establishing a product keyboard fault.

run `20261103-201530-973ed9806950`, source `a53dc6983614490c4e35ef77b5edc26b613e5cd3`,
used private driver `cfae892f8a9b5c9c552a721db9b8885e41ba957b20135d67add2709d6163f3b7`
(predicate at line 305). `modal-query-baseline.json` records true with css height
842 and owned webview bounds `[0,128,1080,2337]`; `failure-6.device.png` shows the
full reader and player without a painted keyboard. the check stopped before the
modal producer. the preceding journey completed its composer clear and native
back input. which field matched, and why, remain unknown.

resolved when an owned-device check retains the exact current-window input-method
evidence and distinguishes shown and hidden keyboard states against actual pixels
and viewport bounds. preserve the failed observation; forced keyboard state or a
weaker assertion would not establish the missing relationship.
