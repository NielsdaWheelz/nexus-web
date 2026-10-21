# release: drop model_cutover_archives

status: owed at the release that carries `0304` · area: release / migrations

`0304` prints the table's census to stdout, then drops it. it converts nothing and
is irreversible: the pre-release backup is the rollback. production's release log
should read

    0304 drops 1 model_cutover_archives rows: 3ea1b8e6e762963ca3cd2d3c9b367ccbe6287dc9@0241

any other census means production's table was not what the rehearsals saw; the
row then survives only in that release's backup and the 0277–0292 release backups.

resolved when: a release has run `0304` and its log shows that line. delete this
file then.
