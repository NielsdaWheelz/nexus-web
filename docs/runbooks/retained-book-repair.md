# retained-book repair

this mechanism repairs derived navigation and apparatus against a verified
original and immutable retained fragments. the epub module owns extraction
semantics; each change's pr owns its scope and proof. unresolved work belongs in
`docs/issues/`; the accepted campaign dispositions remain in
[the scope record](../book-repair-plan.md#outcome-and-scope).

## commands and fences

```text
python -m nexus.ops.reader_navigation_repair inspect --media-id <id>
python -m nexus.ops.reader_navigation_repair apply --media-id <id> --generation <n> --inspection-digest <sha256>
```

inspect is read-only. approve its complete projection, including unchanged fields,
against the original source. counts or an empty diff are not content proof.
apply recomputes the plan and checks source, generation and installed metadata
under the existing publication locks. a stale or incomplete proposal refuses.

changed apply installs navigation, apparatus, groups and reconciled source issues
atomically. publication generation and suggestions input revision advance once;
the counter lock is last and one notification is emitted. unchanged, refused and
rolled-back operations write nothing. do not use a global counter difference to
attribute concurrent owner writes.

preserve fragments, canonical html/text, source objects/assets, ownership and
membership, credits, saved positions, highlights/notes/citations/connections,
indexing and unrelated jobs. preserve existing apparatus identities and edges.
only a separately source-proved numeric-label enrichment may extend its derived
range at the same fragment/start; every other identity/range fence stays strict.

verify each complete installed projection, generation, identities and notification.
fresh inspect and a fresh-fence apply must be unchanged. compare protected state
on the isolated clone; live comparisons must distinguish legitimate concurrent
writes. an api projection does not establish rendered or physical-device behavior.

## uncertainty and recovery

lost output, timeout or interrupted apply is unknown. stop later writes, confirm
the named operator and database backend stopped, then reconcile the full approved
projection, source, generation and protected identities. record a proved commit;
only a proved non-commit permits another freshly fenced attempt. never infer
success from generation alone or retry blindly.

retain operator identity, actual imported code, limits, terminal state and output.
never print credentialed docker configuration. ordinary-worker and maintenance
resource profiles qualify separately. an attach timeout does not stop a container;
exit137 alone does not establish oom. recover evidence before removing resources.

rollback restores a verified backup with writers stopped and discards later
writes. it is an explicit recovery decision, not a reverse repair. preserve useful
sources/receipts; delete temporary probes and only owned resources after acceptance.
