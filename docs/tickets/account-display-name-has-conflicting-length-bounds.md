# account display name has conflicting length bounds

status: deferred · origin: 2026-10-05 source audit at `5bc79139d1a0681eddcc7cafbdfc10895577bb12` · area: account settings. source qualified; runtime not run.

`apps/web/src/app/(authenticated)/settings/account/SettingsAccountPaneBody.tsx:547` limits the input to 80 UTF-16 units, and `:262` says “between 1 and 80 characters.” native `python/nexus/schemas/user.py:15,51` accepts at most 100 Unicode code points; `python/nexus/services/users.py:56,62–65` strips the name and enforces that same 100-point bound. valid native names of 81–100 characters, or shorter non-BMP names, may be unavailable through the web form. no live reproduction is claimed.

prerequisite: choose the intended product maximum, counting unit and trimming policy. align the form limit and error copy with the native ingress/service contract. this behavior change is outside the current profile transport slice.

acceptance: one chosen bound throughout, accurate feedback, and actual input/save/reload checks for its boundary and non-BMP names; names accepted natively must remain editable through the form.
