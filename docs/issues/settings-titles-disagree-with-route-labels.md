# settings titles disagree with route labels

problem: settings destinations use title case while their routes use sentence
case for the same place: "Reader Settings" (`apps/web/src/lib/navigation/destinations.ts:99`,
`app/(authenticated)/settings/SettingsPaneBody.tsx:21`) against "Reader settings"
(`lib/panes/paneRouteModel.ts:67`). the settings index's "Keyboard Shortcuts" and
"Linked Identities" disagree with their routes' "Keyboard shortcuts" and "Linked
identities" (`paneRouteModel.ts:69-70`).

impact: one destination shows two names depending on the surface (settings index,
nexus, pane chip, reader menu).

proposed fix: one name per destination, owned by the route model; destinations
and the settings index read it.

resolved when every settings destination shows the same name on every surface.
