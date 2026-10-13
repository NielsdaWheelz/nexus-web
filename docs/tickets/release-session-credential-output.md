# private credentials printed during release investigation

status: open · origin: 2026-10-13 release session · area: operator credentials

the release coordinator printed the private skid client configuration, and a
delegated audit printed `deploy/env/env-android-release`, into this session's
tool results. those files contain peer bearers and android signing material.
no values are reproduced here. this is evidence of exposure in the session,
not evidence of third-party access.

preserve the android signing identity: an unplanned key change breaks updates
for existing installations. treat the session and exports as private. assess
who can access the retained results; if they crossed the owner's trust boundary,
revoke the affected peer bearers and plan signing-key recovery with installation
continuity explicitly addressed. avoid copying this session into public issues.

done when the owner has assessed retained-result access and either confirmed
containment or completed the scoped credential recovery. operator probes must
parse credential files internally and emit only selected nonsecret metadata.
