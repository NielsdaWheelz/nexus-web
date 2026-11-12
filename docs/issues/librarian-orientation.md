# deferred: librarian orientation

v1 deliberately has no automatically maintained orientation document or memory
tree. it uses the manually edited reading brief, bounded recent conversation and
search over current resources and retained messages.

impact: the librarian can miss an old subject when recent context gives it no
reason to retrieve it. durable history does not guarantee recall.

evidence: owner decision, 2026-11-11, during the librarian specification interview;
orientation was explicitly removed from v1 to limit implementation complexity.

follow-up: assess actual missed connections after the single conversation ships.
if warranted, design one bounded, inspectable orientation with source references;
keep inferred interests subordinate to explicit instructions. do not import a
memory tree or another agent runtime by default.

resolved when representative missed-context cases are either handled by the
existing retrieval path or justify an independently reviewed orientation design.
