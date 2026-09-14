# concurrent first cdp calls replace the listener owner

status: open
origin: 2026-09-13 bounded-workspace browser qualification
area: test dependency / vitest4.1.10

`@vitest/browser/dist/index.js:2722` checks its handler cache before awaiting
the shared CDP session promise. concurrent first calls resume and independently
create/replace handlers for that session. listener registrations on earlier
handlers then cannot be removed by the final handler. receipt
`5a84d2eeb08c9d9c/component-1.log` retains an undefined-listener error with
ordinary on/off (the separate once defect is no longer invoked).

the experiment now awaits one CDP request before registering listeners.
prerequisite: reviewed upstream fix/update. share the handler initialization,
not merely the raw session promise. acceptance: two concurrent first listener
registrations and their removals succeed without leaked or missing listeners.
