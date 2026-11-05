# qualify the signed firefox extension 1.1.0 after persistent installation

status: `NOT_RUN`. on 2026-11-05 the owner waived persistent installation and
product-import qualification for source
`191ae44612d22626251a0d17950d3077d89650da`, extension `1.1.0`, wire `19`.
mozilla approved and signed the package; its matching payload was verified.
the current signed package has not been persistently installed and exercised.

the published artifact is
[nexus-capture-1.1.0.xpi](https://github.com/NielsdaWheelz/nexus-web/releases/download/android-v0.3.11/nexus-capture-1.1.0.xpi),
under `android-v0.3.11`, with sha256
`b74e5bff7fc5d54000a5caa6dbc7565d0ce2e539266cb7bace196700194bf3fe`.

resolve by installing this signed artifact in an authorized firefox profile,
restarting firefox, and observing sign-in, the x host grant, one toolbar add,
one x share-menu add, library placement and reviewed removal against the paired
wire-19 server. [native wheel delivery](extension-popup-pointer-qualification.md)
and the [stopped oracle](release-extension-uncertain-filing-refusal.md) retain
their separate restrictions and qualification gaps.
