# the echo: the armed title shown after the caret

status: deferred by the owner 2026-11-14 in the headword interview. the desktop
caret echo is not built; the phone's shipped `go · {armed name}` is a separate
status line, described in [app navigation](../modules/app-navigation.md).
direction sheet: https://claude.ai/artifact/NrP61YyH3wkVVFr6R5j5wX
("considered, and left out").

## what it is

while typing in the palette, the title of the armed row is echoed in muted ink
directly after the caret, so the target of enter is legible where the eye
already is:

```
⁂  seb▏ald                      when the title extends what was typed
⁂  kan▏ → Critique of Pure Reason   when it does not (a token, a byline, a latch)
```

it is display only. it is not a selection, it is not accepted by ⇥ or →, and it
never changes the input's value. it is a projection of the armed row and adds no
state to the engine.

## why

three of the four concepts drawn independently for the headword asked for it.
the argument: the eye is on the caret; law 2 already says enter fires what the
reader perceived; the echo makes perceiving cost no eye travel. chrome's omnibox
has completed inline since its first version.

the argument against, which won for now: on the headword page the first line
sits 44px under the caret and is armed by default, so the echo mostly repeats
what is already in the fovea's edge.

## behaviour, as proposed

- it appears 80ms after typing pauses, never while a key is held, and never
  after a backspace (a deletion means the reader is correcting, not confirming).
- it follows the armed row, so it changes when arrows or a deliberate pointer
  change the arming, and it disappears when the legend or the catchword is
  armed.
- it is absent while an input method is composing, absent in right-to-left
  text, and absent when the title would overflow the field.
- under reduced motion it appears without a fade.
- it is hidden from the accessibility tree: `aria-activedescendant` already
  names the armed row.

## what it needs

- the shipped desktop headword page (`components/nexus/desktop/DesktopNexus.tsx`
  under `apps/web/src`; [contract](../modules/app-navigation.md#nexus-content-grammar)).
- an overlay measured against the input's text width. the known traps are from
  florian schulz's typeahead notes
  (https://blog.florianschulz.info/2025/10/typeahead): safari kerns each span
  separately, so the overlay's offset must be compensated; the echo must scroll
  with the input when the text overflows; the placeholder and the echo must
  never show together.

## cost and risk

small and contained in the desktop renderer, but fiddly: three text engines,
composition, long titles, and the serif query faces of the study and the solar
each kern differently. a misplaced echo reads as a bug in the field itself.

## resolved when

the owner takes it up or closes it. if built: in chromium, firefox and safari,
in all three rooms, the echo sits on the query's baseline within a pixel of
where typed text would continue, never appears during composition, and enter
fires exactly the row it names.
