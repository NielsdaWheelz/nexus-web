# android app-link default selection remains unqualified

on the physical release handset, signed android 0.3.6/code26 at source
`400e7039e07387b08c23d13d113f9c14a1646bcf` reports
`nexus.nielseriknandal.com: verified`, with link handling allowed, but user 0's
selection lists that domain as `Disabled`. generic `resolve-activity` returns
`android/com.android.internal.app.ResolverActivity`.

a canonical https `am start -W` without a package override delivered to the
already running `app.nexus.android/.MainActivity`. this proves foreground native
intent receipt, not automatic cold external-link selection. the stored user
selection was preserved; its origin is unknown. this is a policy/qualification
boundary, not evidence of a certificate or routing defect.

resolved when the owner explicitly dispositions the existing default selection,
or authorizes a default change and a cold external-link check proves the chosen
behavior. no app data reset is needed.
