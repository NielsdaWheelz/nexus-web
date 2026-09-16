# boot guard installation precedes its required enrollment

status: open · origin: 2026-09-07 pr #203 release preparation; retained during
2026-09-16 cleanup · area: codex host runbook · oi-138

the first production run of release0977dfe3 followed the documented order and
failed boot-guard installation with "Codex credential state storage is not the
dedicated encrypted mount". the mount was present; the enrolled auth file was
not. enrolling first allowed installation. this is historical operator evidence,
not a newly reproduced production failure.

the same ordering remains at6f03df73: the runbook installs the guard at
`docs/runbooks/codex-personal-agent-host.md:181`, before enrollment at:200.
`deploy/hetzner/release.py:3859` calls `_require_codex_state_storage`, whose
line3633 requires the enrolled credential file and lines3645–3650 validate it.
a newly mounted credential volume cannot meet that prerequisite yet.

fix: place enrollment before guard installation while retaining the existing
storage and credential checks. distinguish a missing enrolled credential from
an invalid mount in operator diagnostics. preserve the documented requirement
that a new host's docker service remain stopped until encrypted storage is ready.

acceptance: the documented fresh-host sequence meets each command's actual
prerequisites; installation succeeds after enrollment and refuses missing or
invalid credential storage. verify on an isolated eligible host, not by
reformatting or rebooting the live release host.
