# firefox installation and capture qualification

problem: persistent firefox installation, normal account connection and an
installed-extension capture remain NOT_RUN. a signed installer alone does not
establish those journeys.

evidence: mozilla approved the unlisted `capture@nexus.local` version `1.0.0`
for production wire 14. its payload matches the official release apart from
the reviewed manifest trailing newline. the normal signed installer is open;
the owner's add/data-consent action remains pending.

resolved when firefox records an active, signed, non-temporary installation,
the declared data categories are accepted, and normal connection plus a unique
disposable capture succeed with exact resource cleanup. future releases remain
owned by [the signing follow-up](release-firefox-signing.md).
