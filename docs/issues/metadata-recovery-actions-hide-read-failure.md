# metadata recovery actions hide their read failure

status: implementation repaired; exact live remedy qualification remains open.

original problem: metadata recovery discarded the resource-menu producer's
loading/failure pseudo-actions while selecting a remedy, hiding a failed read.

current source: `components/media/MetadataResearchActions.tsx` uses
`lib/actions/useResourceActions.ts` and explicitly renders local pending,
failure and retry. the reader owns no menu deadline. source review passes;
the action-menu lab lacks a supported fixture for a genuinely missing metadata
source that exposes this remedy. uploaded pdf/highlight checks exercise the other
non-menu owner and cannot establish this path. do not fabricate metadata facts.

resolved when a failed remedy read explains the failure and offers retry, pending
is distinct from ready-with-no-remedy, and successful recovery commands retain
their existing execution semantics.
