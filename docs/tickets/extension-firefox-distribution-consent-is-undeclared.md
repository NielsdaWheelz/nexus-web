# firefox signed distribution is not yet produced

status: deferred · origin: 2026-09-23 firefox v1 review · area: extension release

`apps/extension/manifest.json` now declares the gecko id `capture@nexus.local`,
`strict_min_version` 153.0, `incognito: "not_allowed"` and
`data_collection_permissions.required = ["websiteContent", "browsingActivity"]`
(page content and page url leave the browser to the user's own nexus; the
extension token is issued by nexus and returned to nexus, so no
`authenticationInfo` category is declared). `bun run build:extension` produces
the unsigned package in `apps/extension/dist`; installation today is temporary
(about:debugging), which firefox discards on restart.

prerequisite: mozilla add-on developer credentials (AMO JWT issuer/secret) for
the owner's account; the origin pins baked at build time must be the production
nexus and storage origins (`NEXUS_EXTENSION_NEXUS_ORIGIN`,
`NEXUS_EXTENSION_STORAGE_ORIGIN`).

fix: sign an unlisted build (`web-ext sign --channel unlisted` or the AMO api)
from the production-origin package, keep the id stable so the identity redirect
host `https://1ddcf81c2e8737ef7e045031d91fb2c3d6b899ae.extensions.allizom.org`
stays allowlisted in `NEXUS_EXTENSION_REDIRECT_ORIGINS`, install the signed xpi
persistently and complete one login and one capture with it. confirm the data
declaration categories against the current mozilla list at signing time.

acceptance: the signed xpi installs on firefox ≥ 153 without temporary mode,
about:addons shows the declared data categories, and a capture completes with
the production origins.
