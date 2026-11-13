# single-effort generation drawing remains unobserved

the composer must omit its effort region and dial when the selected variant has
exactly one advertised effort. the branch is reviewed, but neither available
catalog supplies that shape: fake-provider run `20261112-231010-f551c96b27c1`
and live-codex run `20261112-232326-6cd530e5e4e4` offer only multi-effort variants.
their private artifacts retain `composer-catalog.jsonl`.

impact: this drawing has no runtime proof. the spec forbids adding a catalog
scenario control just to manufacture it. `GenerationPicker.tsx` owns `fixed`,
the dial condition and the effort-region condition.

resolved when a real catalog supplies a single-effort variant and both supported
browsers show its label with no dial or effort region. retain exact catalog
labels and the always-pressable model control.
