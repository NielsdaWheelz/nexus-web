# account settings release

api, web, android 0.3.15 and firefox 1.1.3 are paired at
`263d295ebeda5849cd8114725f0a1dbaf5cead41`, wire 23/schema 0345.
installed observations have the owner's [release-scoped deferral](release-installed-clients-263d295eb.md).

owner checks required outside the chromium lab:

- on an account with two identities, unlink one; prove the identity disappears,
  the remaining sign-in still works and uncertain retry retains its command.
- on the installed app, follow connect to the hosted account page, follow the
  password link, open and use the calendar zone sheet, then guarded sign out.
  repeat hosted account links with a different browser account; the assertion
  must refuse it. include keyboard retry and focus after an unlink settles.

the lab seed has no oauth identity; chromium does not qualify installed hosts.
these paths receive source review only in this change. resolved when the paired
release and those owner observations are recorded in the pr.
