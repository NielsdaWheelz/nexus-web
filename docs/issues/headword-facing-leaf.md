# the facing leaf: the palette shows the armed thing in context

status: deferred by the owner 2026-11-14 in the headword interview ("record …
as issues, in detail; they shouldn't be in this spec if they're not going to be
implemented now"). not built. direction sheet:
https://claude.ai/artifact/NrP61YyH3wkVVFr6R5j5wX ("considered, and left out").

## what it is

the palette becomes a spread. the list is the verso; a second page beside it,
the recto, shows the armed row in context without leaving the palette:

- a passage: its paragraph in the reader's face, the match underlined.
- a highlight or a note: its words at reading size, with its source.
- a work with no evidence: a catalogue card (title, byline, how far read, the
  last place).
- a place or a command: nothing. the recto stays blank.

## why

a launcher's target is recognised by its name. a reader's is often recognised
by its context: a clipped 36px line is a poor cue for a passage. the palette's
only way to see more today is the `show excerpt` verb, which opens a dialog over
the palette (`apps/web/src/components/resources/ExcerptDisclosure.tsx`). sublime
text, telescope and the framer theme of cmdk prove the form: browsing becomes
reading without committing.

## behaviour, as proposed

- geometry: the page grows from 720 to about 960 wide (list 560, leaf 400). below
  roughly 1040px of window the leaf is absent and the palette is the headword
  page alone.
- timing: the leaf paints once a row has been armed for 180ms, or at once when
  the arming was deliberate (arrows, pointer travel). fast typing never
  flickers it. content swaps by opacity over about 70ms; nothing translates.
- the leaf never delays the keystroke paint: it renders after the list.
- it is display only. it takes no focus and no keys; enter still fires the
  armed row. it is hidden from the accessibility tree or it chatters on every
  arrow press.
- with the leaf present, `show excerpt` and its dialog leave the desktop palette.

## what it needs first

1. **recents that remember a place.** a recent holds a title hint, a detail hint
   and an order (`apps/web/src/lib/recent/model.ts:8-9`): no time, no position.
   on the blank page, which is the page seen most, the leaf would be empty. the
   owner declined `used_at` for now in the same interview; a place hint
   (`p. 212`, `41:07`) is a further addition to the device-local record
   (format 2 to 3, a hard cutover).
2. **the words.** a row carries only its preview window. the full excerpt is a
   read (`excerpt_mode: "full"`, `ExcerptDisclosure.tsx:45`). so the leaf is
   either limited to the window the row already has, or it fetches on arming,
   which the content grammar forbids for decoration ("no metadata is fetched to
   decorate a row", `docs/modules/app-navigation.md`). that rule needs an
   explicit exception or the leaf shows only what arrived.
3. **progress and last place for works.** not on the workspace-presentation wire
   (`python/nexus/schemas/workspace_presentations.py:72-79` carries ref, title,
   kind, contributors, source label).
4. the shipped headword's fixed page geometry
   ([contract](../modules/app-navigation.md#nexus-content-grammar)); adding the
   leaf must preserve its list and arming behavior.

## cost and risk

- the largest css surface of any palette idea: a second column that must hold
  still in three rooms and vanish cleanly on narrow windows.
- a recto that is blank for places, commands and most recents may read as
  unfinished. it earns its place only once item 1 lands.
- a fetch per armed row, if allowed, needs debounce and abort; arrows held down
  must not queue reads.

## resolved when

the owner takes it up or closes it. if built: on a window at least 1040px wide
the armed passage is readable in context beside the list within 180ms of
arming, typing never flickers it, a screen reader hears nothing new, and the
page's left column is pixel-identical with and without the leaf.
