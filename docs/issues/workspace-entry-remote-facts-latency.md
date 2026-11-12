# workspace entry waits for remote presentation facts

`docs/modules/workspace.md:99-110` and
`apps/web/src/lib/authored/BrowserWorkspace.tsx` allow up to five seconds for
initial remote presentation facts before publishing the desktop shell. this is a
design allowance, not a measured five-second delay on every launch.

2026-11-12 decision: the owner made 400 ms a design target, not a hard cap, and
explicitly excluded workspace startup from the
[librarian responsiveness scope](../librarian-responsiveness-spec.md).

follow-up: measure ordinary saved-workspace startup separately from provisioning
and pane navigation. if remote titles materially delay usable local content,
consider publishing the shell first. tradeoff: incomplete initial remote titles;
retain identity, geometry, writing authority and honest failures.

resolved when actual startup measurements support retaining or changing that
policy. the librarian change does not claim to resolve this follow-up.
