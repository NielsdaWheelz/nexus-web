# the model_cutover_archives drop waits on a rehearsal

status: open · origin: 2026-10-13 production release; 2026-10-19 repair purge · area: migrations

the table holds one row, the reviewed 0246 reset (target `3ea1b8e6e`, from
`0241`): its census and disposition, not the model-call history 0246 deleted.
that history exists only in the `3ea1b8e6e` release backup, which the drop does
not touch.

the owner waived the r2 retention read on 2026-10-19. no credential here can
read the bucket's lifecycle rules (`AccessDenied` three times, 2026-10-13 and
2026-10-19), so whether r2 keeps these backups is unknown. read-only `HEAD`s on
2026-10-19 found every release backup present, with no object-lock or expiry
headers:

| backup | revision | bytes | sha256 |
| --- | --- | ---: | --- |
| `releases/3ea1b8e6e762963ca3cd2d3c9b367ccbe6287dc9/database.dump` | 0241, the deleted history | 1,461,885,299 | `64219d560730162f06019a8a5d1300fe834877349a8ea7bfcc9916941fc18790` |
| `releases/665e7b3af03282d37ac1a2aac3c6589e2a0f5932/database.dump` | 0277 | 1,270,550,847 | |
| `releases/0bd6619236ae911bb35741aa2017a4a44312cdf2/database.dump` | 0278 | 1,268,609,995 | |
| `releases/fdd0a3ecade305082643f6231bbfbcce211b04d7/database.dump` | 0287 | 1,268,443,385 | |
| `releases/8a67e218ae28cedf89932d7feb13d5cffea05c60/database.dump` | 0292, restored 2026-10-19: holds the archive row | 1,296,042,015 | `f92a4a68df62055264e89a9bd378833c3b0208beae72e68b738c2a51d849e702` |

the drop is held on branch `cleanup/drop-model-cutover-archives`, built on the
pre-merge purge branch. it prints its census to stdout, which the release log
keeps, then drops the table.

before it merges: rebase it on main, renumber it after main's head (#676 took
`0294`), and rehearse it on the newest production backup. the `8a67e218a`
backup cannot run #671's `0293` unrepaired (it refuses one x media), so the
rehearsal needs a backup taken at `0293` or later, i.e. after the next release.

resolved when: the drop branch merges after that rehearsal; delete this file in
that merge.
