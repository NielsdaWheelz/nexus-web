# the model_cutover_archives drop waits on the r2 retention read

status: open · origin: 2026-10-13 production release; 2026-10-19 repair purge · area: backup / migrations

the owner keeps the r2 retention check before `model_cutover_archives` is dropped
(2026-10-18). the table holds one row, the reviewed 0246 reset (target
`3ea1b8e6e`, from `0241`): its census and disposition, not the model-call history
0246 deleted. that history exists only in the `3ea1b8e6e` release backup.

nothing on this machine can read the bucket policy. `GetBucketLifecycleConfiguration`
on `nexus-database-backups` answered `AccessDenied` with the backup credential on
2026-10-13 and on 2026-10-19 03:21 utc, and with the app's r2 credential on
2026-10-19 19:17 utc; there is no cloudflare api token or wrangler login. so the
policy is unknown, not absent. read-only `HEAD`s on 2026-10-19 found every release
backup present, with no object-lock or expiry headers; a five-day-old object
surviving rules out only an expiry shorter than five days.

| backup | revision | bytes | sha256 |
| --- | --- | ---: | --- |
| `releases/3ea1b8e6e762963ca3cd2d3c9b367ccbe6287dc9/database.dump` | 0241, the deleted history | 1,461,885,299 | `64219d560730162f06019a8a5d1300fe834877349a8ea7bfcc9916941fc18790` |
| `releases/665e7b3af03282d37ac1a2aac3c6589e2a0f5932/database.dump` | 0277 | 1,270,550,847 | |
| `releases/0bd6619236ae911bb35741aa2017a4a44312cdf2/database.dump` | 0278 | 1,268,609,995 | |
| `releases/fdd0a3ecade305082643f6231bbfbcce211b04d7/database.dump` | 0287 | 1,268,443,385 | |
| `releases/8a67e218ae28cedf89932d7feb13d5cffea05c60/database.dump` | 0292, restored 2026-10-19: holds the archive row | 1,296,042,015 | `f92a4a68df62055264e89a9bd378833c3b0208beae72e68b738c2a51d849e702` |

the drop is held on branch `cleanup/drop-model-cutover-archives`, off
`cleanup/repair-purge`, as migration `0294` (#671 took `0293`). it prints its
census to stdout, which the release log keeps, then drops the table.

step: with an account that can read bucket configuration (cloudflare dashboard →
r2 → `nexus-database-backups` → settings: object lifecycle rules and bucket
locks), confirm no rule expires the `3ea1b8e6e` and `8a67e218a` keys, or lock
them; record the policy here. or the owner waives the check here.

then, before that branch merges: rebase it on main and renumber it after the
head of the day; rehearse it on the newest production backup. the `8a67e218a`
backup cannot run #671's `0293` unrepaired (it refuses one x media), so that
rehearsal needs a backup taken at `0293` or later.

resolved when: the policy or waiver is recorded here and the drop branch merges;
delete this file in that merge.
