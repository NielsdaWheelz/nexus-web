# encrypted-state provisioning lacks a measured memory bound

status: open · origin: 2026-09-07 pr #203 release preparation; retained during
2026-09-16 cleanup · area: codex host provisioning · oi-139

the first production format attempt for release0977dfe3 was oom-killed on the
2-gib host at18:43 utc. the retained operator note records the kernel killing
cryptsetup with anon-rss836452 kib. the interrupted attempt left a luks2 header
without keyslots: `isLuks --type luks2` succeeded, but the volume could not open.
this is historical evidence, not a new incident or a claim about today's header.

at6f03df73, `docs/runbooks/codex-personal-agent-host.md:158` still invokes
`cryptsetup luksFormat --type luks2` without an explicit memory bound or keyslot
verification before opening. formatting and later unlocking must fit alongside
the existing services; successful `isLuks` alone does not prove a usable keyslot.

fix: qualify an explicit argon2id memory cost against the existing host's
available memory and passphrase requirements, document that tradeoff and the
format/unlock prerequisites, and verify the intended keyslot after formatting.
the original note suggested256 mib; that is a candidate requiring qualification,
not an established safe production setting.

acceptance: isolated format and unlock with the documented parameters complete
within the measured budget, a usable keyslot is present, and an interrupted
format is detected before claiming readiness. retain interactive off-host key
custody. do not reformat or reboot the existing production volume for this work.
