# retained writing after a render failure

a render failure unmounts editor/work guards; the account writing runtime
retains failed input and refuses to close it. the existing authenticated error
boundary independently guards browser reload and native exit, and exposes that
runtime's retry/copy. browser and native workspace roots pass their actual
account id; the authored provider also registers its uncommitted runtime with
the ordinary work guard. committed pending synchronization is never loss risk.

native run `20261025-161649-c51c195bcaf9` exposed an unguarded shelf root: an
attached-note menu threw for a missing mobile chrome provider and React removed
the tree. the capture itself was already durable in native sqlite; this is not
evidence of lost writing. the shelf now mounts that provider and the same error
boundary under its account scope, continuously from loading through ready,
passing the real account id when known. no second recovery owner is introduced.

remaining proof: fail a real local save, then encounter a render failure; retained
input must remain copyable/retryable and decline browser reload/native exit.
lab30 proves the ordinary worker-failure copy and reload guard, not this combined
render-failure path. remove this record after that narrow proof.
