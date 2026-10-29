# command palette release

implementation in progress; qualification pending. contracts:
[search](../modules/search.md#launcher), [navigation](../modules/app-navigation.md#nexus-content-grammar).

- pair consuming web code with android's packaged `SEARCH_READ_SQL` allowlist
  for the compound `search_preview` and `search_admission` queries. qualify both sqlite hosts;
  no old-shell query fallback or kotlin ranking copy.
- regenerate web wire types after `/search/preview` declared maxima change
  from `4/2/2` to `8/8/8`. wire 17 already follows deployed wire 16 (see `docs/reauthoring.md`);
  retain that unreleased bump. use the existing paired-client reload/refusal steps.
- no authored format change, database migration, corpus rebuild or new index
  belongs to this design. record a newly demonstrated requirement before adding it.

resolved when paired artifacts, required platform qualification and the wire
decision are recorded in the implementation pr/release. this record authorizes
no deployment and claims no completed checks.
