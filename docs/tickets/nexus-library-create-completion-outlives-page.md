# nexus library completion can overtake a later interaction

status: open; separate from the libraries pane change
origin: 2026-10-14 design review; reconfirmed on current main `69c00182c`, 2026-10-15
area: web / nexus library creation

`apps/web/src/components/nexus/useNexusController.ts:264–276` attaches unguarded
completion callbacks: success navigates; failure restores the captured page.
`guardExit` at280–285 protects only add. leaving the create page or starting
another task does not revoke the old observer. source confirmed; no production
mutation or delayed launcher journey performed.

reproduce: hold a library-create response, leave the launcher form or start
another action, then release success/failure. the earlier completion can
navigate or resurrect its page over the newer task.

fix: settle launcher dismissal semantics and enforce interaction ownership in
its controller. a committed result still publishes through the library api;
its former presentation must not regain navigation/page ownership.

acceptance: delayed success/failure cannot overwrite a newer task; repeated
submit is suppressed; uncertainty retains the original command identity.
