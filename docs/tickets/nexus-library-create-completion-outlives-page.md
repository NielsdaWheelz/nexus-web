# nexus library creation can overtake a later interaction

status: open
origin: 2026-10-14 libraries-pane design review; checkout `367da80e0c1beb1c426f6d2d72201b0733809b50`
area: web / nexus library creation

`apps/web/src/components/nexus/useNexusController.ts:293-304` attaches
unconditional completion callbacks to library creation: success navigates and
failure restores the captured create page. `guardExit` only protects add
(:307-313); back/escape can replace the page (:358-369), and another quick action
can replace it (:331-341). the controller remains mounted when its surface
closes (`apps/web/src/components/nexus/Nexus.tsx:11-19`). this is source-confirmed;
no delayed request was exercised against production.

reproduction: delay the create-library response, submit, leave the form or
start another nexus action, then release success/failure. the old completion
can navigate away or resurrect its form over the later interaction.

prerequisite: choose the pending operation's dismissal semantics. enforce them
in the controller for every exit. if dismissal remains allowed, completion
must not regain navigation/page ownership after that ownership was relinquished;
the committed result must still publish through the library client.

acceptance: delayed success and failure cannot overwrite a newer task; repeated
submit is suppressed; uncertain retry retains the original command identity.
