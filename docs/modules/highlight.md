# highlights

highlights are independently identified authored selections. the shared authored
kernel owns their state and merge; device sqlite owns durable local commands;
python `services/authored` owns replication and relational projection. existing
`highlights.py`, location resolution and schemas expose the
server read/tool contracts. reader surfaces own paint, hit-testing and selection
presentation. chat owns quotation context and run assembly.

## identity and capture

create mints one random client uuid and retries retain it. independently created
overlapping or identical extents remain distinct highlights, each with independent
notes and links. no extent singleton, duplicate alias or resize collision exists.
editing and deleting always address one exact id.

a highlight has immutable source ref, observed-delete liveness, a selection
register and a separate color register. the greatest `(lamport,replica_id)` wins
each scalar register. selection publication, typed locator, literal quote and
prefix/suffix travel together; concurrent resizing selects one coherent capture.
resizing preserves the highlight id and every attached-note link.

a reusable passage binding is separate from a highlight. passage identity is
source plus normalized exact/prefix/suffix; literal captures are not rewritten by
matching normalization. same-key captures merge their hint register and retain
known ids. differing publication/locator evidence is not another identity.
a geometric pdf selection may have no textual passage ref and an empty quote.

## local interaction

an unsubmitted selection composer is ephemeral. its existing explicit save commits
the highlight, optional independent note and links in one durable local command.
attached-note editing subsequently autosaves through the ordinary note owner.
multiple notes remain independent; unlinking or deleting an annotation does not
consume them. canceling a creation dialog commits nothing.

hosted and downloaded readers share the annotation controller. local authored
queries own annotation reads online as well as offline. sources already on the
device remain annotatable without a network publication lookup. retained source
stubs/quotes/labels do not grant access to unavailable bytes. direct native source
mainframes and subframes receive no authored bridge authority.

the passive mobile row retains the shared highlighter and overflow controls with
notebook/pen and question openers. names describe the next action, and unavailable
controls remain focusable with their reason. copy uses the frozen nonblank quote
unchanged, independently of note saving or remote action reads. desktop copy/share
remain direct commands; mobile keeps copy/share, colors and existing-chat choices
in overflow. closing an unused menu returns focus to the reader; completed commands
retain their own focus transfers. the sheet keeps its native close handle and
fixed toolbar above the scrolling editor.

## locations and source generations

reflowable locations use canonical codepoint offsets. dom provenance maps source
spans to canonical codepoints for selection and paint; normalization can compose
or expand source characters. mixed-atom note locations use the shared canonical
text projection, never an independent editor-text approximation.

pdf locations use canonical page-space quads. viewport transforms are derived
presentation; geometry normalization belongs to the shared semantic owner and
retains the existing precision rules. every overlap remains selectable even when
its paint coincides with another annotation.

store the mounted publication identity with the original literal quote and typed
locator. a source change before upload does not reject the already committed
capture. exact valid relocation may update a derived location. absent or changed
publication provenance requires unique quote resolution; ambiguity remains beside
the saved quotation. unknown provenance never permits blind offset reuse.

reader projection and relocation caches are rebuildable. source teardown retains
authored highlights, geometry, quotes, passage identities and independent notes.
source foreign keys cannot cascade or reject an accepted offline capture merely
because original bytes/generation no longer exist. current reading permission
still belongs to the source owner.

## server and migration

server tools create captures through the same semantic owner and feed, inside
their existing permission/fencing boundary. no direct highlight projection writer
or whole-body annotation-note endpoint remains. server reads honor semantic
liveness and keep captured writing available independently of source access.

revision 0318 freezes old grammar conversion and preserves current highlight,
note, link and passage ids. old annotations without proved publication provenance
seed `publication:null`; their literal quotes and locators survive. unsupported
records and conflicting live semantic bindings refuse the transaction. paired
release, backup and device qualification belong to the
[release issue](../issues/release-local-first-writing.md).
