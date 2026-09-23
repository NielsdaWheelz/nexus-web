# firefox distribution data declaration is missing

status: deferred · origin: 2026-09-23 firefox v1 review · area: extension release

`apps/extension/manifest.json:24-28` declares only the gecko id. capture transmits
page urls and content to nexus. mozilla requires data-collection declarations
for new extensions submitted from 2025-11-03; the existing manifest has none.
no submission was attempted and existing add-on registration status is unknown.

evidence: [mozilla's distribution contract](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

prerequisite: settle the minimum firefox version and signed distribution route
before release; this is not a blocker to temporary local installation.

fix: declare the actual required data categories, retain local packaged code,
and use a stable signed extension id matching the auth redirect allowlist.

acceptance: the chosen signed package installs on the supported firefox version,
shows truthful permissions/data disclosure, and completes login with its real id.
