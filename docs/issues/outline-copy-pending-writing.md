# copying pending outline writing

the prior outline copied only the runtime's frozen creation intent and shared
documents. later typing and return segments still owned by its input could be
omitted after a failed first local commit.

the replacement retains those fields in `OutlinePendingInput` and supplies a
fresh `copyText()` callback through the existing workspace work owner. both the
mounted outline and stopped-workspace surface offer “copy pending outline text”.
“copy unsaved note edits” remains a separate runtime export; the exports can
overlap and must not be concatenated. the account-keyed work provider now outlives
the workspace boundary. shelf passage input retains its existing ephemeral policy.

reproduce with an actual first local commit failure, continue typing/returning,
then use copy writing before restarting. compare copied text with every visible
pending segment and the active body, including spaces and hard breaks. repeat the
copy after further typing. source review is complete; real failure/clipboard and
retained-boundary behavior remain unqualified.

prove all visible pending words can be copied before explicit restart/discard,
without changing the runtime's exact-byte retry or loss guard. a stopped-store
failure can prove copying, but cannot qualify successful retry.
