# Nexus Chapbook — the pocket-instrument thesis

Status: VISION — clean-sheet mobile council, 2026-07-26

This document deliberately ignores the current application shell and asks what
Nexus mobile should be if it were designed from first principles today. It is a
product and systems thesis, not an implementation contract.

## The verdict

Nexus on a phone is not a smaller workspace. It is a **pocket instrument for
attention**:

- catch something before it disappears;
- choose what deserves attention now;
- read, listen, or watch without administrative chrome;
- mark a passage or moment without breaking concentration;
- turn that mark into a thought, connection, or grounded question;
- return to the exact place after any interruption.

The artifact stays sovereign. Tools arrive, help, and recede.

The test for every mobile decision is:

> Does this help the user stay with, return to, or transform what they are
> attending to?

If not, it probably belongs on a larger screen, behind Search, or nowhere.

## The one-line diagnosis

Most knowledge apps expose their ontology: inboxes, databases, media types,
graphs, assistants, workspaces, sidebars, and settings. A phone should expose
the user's **next intention**, not the system's nouns.

This produces a simple public structure:

```text
Home             Library          Notes             Search
resume / choose  consume / file   think / connect   find / ask / act
```

Capture is a global action, not a destination.

Playback is a persistent utility, not a destination.

AI is a capability inside Search, reading, and writing—not a fifth room.

Articles, books, PDFs, podcasts, videos, newsletters, highlights, and pages are
not separate apps. They are projections over one personal corpus.

## Product promise

The common meaningful action should be one or two deliberate moves away. A
move means a navigation or action choice, not typing, selecting text, or
scrolling.

| Intention | Path |
| --- | --- |
| Resume the last source | Open → Continue |
| Resume playback | Tap the MiniPlayer |
| Open the inbox | Home → Inbox |
| Save from another app | Share → Nexus |
| Queue a visible source | Swipe or visible row action |
| Find anything | Search → result |
| Ask the corpus | Search → Ask |
| Highlight a passage | Select → Highlight |
| Add interpretation | Select → Note |
| Link a passage | Select → Link → target |
| Ask about a passage | Select → Ask |
| Return from an answer | Back → exact source anchor |
| Make a timestamped note | Player → Note |
| Open contents or chapters | Reader/Player → Contents |
| See connections | More → Connections |
| Start a note | Notes → New |

This is not achieved by showing every command everywhere. It is achieved by
putting the right four or five verbs next to the object they act on, then
making Search the escape hatch for everything else.

## The philosophy

### 1. Continuity outranks navigation

Every departure must know how to bring the user home. Preserve:

- exact reading anchor, not only a percentage;
- playback time and queue;
- text selection when practical;
- note and message drafts;
- transcript follow state;
- originating object and return focus;
- the source/version behind every citation.

Phone calls, locks, crashes, deep links, rotation, keyboards, and AI tangents
are normal conditions. Restoration is a core feature.

### 2. Content is the interface

The default reader is a page, not a dashboard around a page. The default player
is the work and its timeline, not a drawer containing metadata. The default
note is writing, not a graph inspector.

Chrome should answer one of four questions only:

1. Where am I?
2. How do I return?
3. What can I do to this?
4. What state must I know right now?

### 3. One attention, many remembered states

A phone can present one primary task well. It can remember many tasks well.
Those are different capabilities.

Do not imitate desktop panes by stacking hidden panels. Give each sustained
task a real route and navigation state. Keep each top-level destination's
navigation stack so switching tabs does not erase context.

### The navigation and return law

One navigation coordinator owns canonical URLs, four ephemeral tab stacks,
system Back, modal precedence, and persisted task restoration.

| Event | Law |
| --- | --- |
| Warm foreground | Restore the visible route, locator, draft, and tab exactly |
| Cold launch | Open Home; never force-open yesterday's artifact |
| Continue | Push the chosen artifact in the Home stack |
| Open from Library/Search/Notes | Push in the initiating tab's stack |
| Follow an in-artifact link | Push in the current stack and record the exact origin locator |
| Switch tab | Preserve the departing stack and restore the destination stack |
| Reselect active tab | Pop to that tab's root; a second reselect scrolls root to top |
| System/predictive Back | Dismiss the top safe transient surface, then pop the current stack, then defer to the OS |
| Deep link while running | Push in the current stack unless the link explicitly names a root destination |
| Cold deep link | Open the canonical artifact route with a synthetic Home origin |
| Finish a full-screen task | Return to its recorded origin, focus target, and locator |

Opening a Source never silently switches the selected tab to Library. The tab
records **why the user arrived**; the Source identity records **what they
opened**. This keeps Back predictable after Search results, links, and AI
citations.

Overlay openness is ephemeral and normally not restored after process death.
User work inside an overlay is a durable draft and is restored as a route or
offered from its origin. Back may close a sheet only when doing so cannot lose
work.

### 4. AI waits at the edge of the desk

AI should be immediately available but never attention-seeking:

- no prompt carousel on Home;
- no glowing assistant badge;
- no unsolicited panel over a text;
- no top-level chat silo by default;
- no machine edit that masquerades as human writing.

The ideal relationship is a brilliant colleague who answers when invited,
shows their sources, can take typed governed actions, and then gets out of the
way.

### 5. Search before synthesis

Search should return exact, immediate corpus matches before asking a model to
interpret them. The user can then promote the same query into Ask.

This keeps retrieval fast, inspectable, useful offline, and honest. AI is a
powerful second pass, not a loading screen in front of the user's own data.

### 6. Save first, organize later

Capture defaults to Inbox. No filing form stands between intent and safety.
The user may optionally choose a collection, but never has to.

Later, triage uses a few reversible verbs: Later, Archive, Delete, Collect.
There is no taxonomic ceremony at the moment of capture.

### 7. Gestures accelerate; controls authorize

Swipes, drags, and long presses reward familiarity. Visible controls and menus
remain the complete interface.

No essential action depends on discovering a gesture. No custom edge gesture
competes with system Back. Dismissal never risks silent data loss.

### 8. Calm is a product capability

There is no infinite recommendation feed, streak pressure, unread shame,
notification garden, or engagement machinery.

Home is deterministic and short. Resurfacing offers one considered memory, not
a slot machine. The application protects attention instead of monetizing it.

## The durable object model

The user should see plain nouns. The system needs a small, precise ontology.

### Public concepts

1. **Source** — something consumed: article, book, PDF, episode, video,
   newsletter, thread.
2. **Passage** — a stable span, page region, chapter, timestamp, or selection
   inside a Source.
3. **Note** — something the user thinks or writes. A Note can cite Sources,
   Passages, or other Notes.
4. **Link** — a meaningful relationship between durable objects.
5. **Collection** — an intentional, static grouping.
6. **Saved view** — a named query over Resources, never a membership owner.

Progress, queue position, format, creator, subscription, generated summary,
and archive state are attributes or projections—not more top-level worlds.

### System concepts

- **Resource**: stable identity for a Source, Note, conversation, or Collection.
- **Source identity claim**: a namespaced canonical URL, feed GUID, DOI/ISBN,
  provider ID, or file hash. Claims suggest aliases or editions; merge/split
  remains reversible and is never inferred from one matching string alone.
- **Representation**: immutable source bytes and source-version provenance.
- **Derived artifact**: versioned extracted text, transcript, chapters,
  thumbnail, chunk set, or embedding set attached to a Representation. A new
  extraction does not invent a new source revision.
- **Locator**: typed position in a Representation:
  text quote plus context and offsets, EPUB location, PDF page/geometry, or
  timed-media range.
- **Annotation**: a highlight, bookmark, or question marker whose target is one
  or more Locators. It is not a second Note store.
- **Citation**: a relational owner connecting a Note to a Context reference.
- **Edge**: typed relationship such as responds to, supports, contradicts, or
  related. Citations and Collection membership have relational owners; graph
  edges may be projected from them.
- **Collection membership**: the relational owner for static membership and
  order; a membership edge may be projected from it.
- **Progress**: explicit completion plus semantic locator or media time.
- **Context reference**: Resource + Representation hash + optional Locator.
  This is the common address for links, search results, citations, and AI
  context; it is not an authorization token, and every read reauthorizes
  against current policy.
- **Mutation envelope**: idempotent device command with actor, aggregate,
  version, logical timestamp, and payload.

Avoid two opposite traps:

- route-shaped storage that fossilizes today's UI;
- an undifferentiated graph where every query becomes traversal archaeology.

Stable relational owners hold current truth. The graph and search indexes are
rebuildable projections.

### The highlight-to-thought law

This central loop has one identity model:

1. **Highlight** creates one Annotation at a Locator.
2. **Note** creates one Note Resource immediately, plus a Citation to the
   Context reference. Quick and full-screen composition are two presentations
   of that same Note ID.
3. **Add note** after highlighting creates a Note that cites the same Context
   reference and may also refer to the Highlight ID. It never stores prose on
   the Highlight row.
4. **Promote to page** changes the Note's presentation/structure, not its
   identity or citations.
5. **Undo Highlight** removes only the new Highlight. It does not silently
   delete a separately authored Note.
6. **Delete Note** tombstones that Note and its owned citations; it does not
   delete the quoted Source or Highlight.

Multiple interpretations of one Passage are multiple Notes. This costs more
IDs and buys a single source of truth for every human thought.

## Phone information architecture

### Home

Home is a reading desk, not a dashboard. It answers “what now?” with at most
four modules:

1. **Continue** — exactly one best nonplaying continuation while media is
   active; otherwise the best in-progress Source.
2. **Up next** — no more than five manually prioritized Sources.
3. **Inbox** — recent untriaged captures, collapsed by default when empty.
4. **From your notes** — one deterministic resurfaced highlight or thought.

No charts. No feature shortcuts. No AI prompts. No recommendations buffet. No
more than one machine-composed item.

```text
┌──────────────────────────────┐
│ Home                       ● │
│                              │
│ CONTINUE                     │
│ The Beginning of Infinity    │
│ Chapter 7 · 42%         18m  │
│ ━━━━━━━━━━━━                 │
│                              │
│ UP NEXT                  All │
│  ○ Essay title          12m  │
│  ○ Podcast title        48m  │
│  ○ Paper title          31m  │
│                              │
│ INBOX                     3  │
│ Three new captures           │
│                              │
│ FROM YOUR NOTES              │
│ “A remembered passage…”      │
│                              │
│ ▶ MiniPlayer                 │
│ Home  Library  Notes  Search │
└──────────────────────────────┘
```

The avatar opens account, sync status, downloads, and settings. The MiniPlayer
is the only optional tab-bar accessory. Capture is a labeled root action or a
Search action; it never creates a second persistent strip.

Continue and MiniPlayer never duplicate one another. While audio or video is
active, the MiniPlayer owns that continuation and Home's Continue offers the
last nonplaying reading or writing task. Otherwise Continue may offer the most
recent in-progress Source of any format.

### The intention states

Four apparently similar lists have different jobs:

| State | Meaning | Size / lifetime | Completion |
| --- | --- | --- | --- |
| Inbox | Acquired but not triaged | Unbounded, durable | Move to Later, Archive, or Delete |
| Later | Worth keeping for future attention | Unbounded, durable | Remains until opened, archived, or deleted |
| Up next | Explicit cross-format shortlist | Ordered, maximum five | Remove on completion; archive by default |
| Play queue | Ephemeral media-session order | Session-scoped | Advance without changing Library state |

Adding a Later item to Up next does not copy the Source. It adds a priority
record over its Library state. Adding an episode to the Play queue does not add
it to Up next unless the user explicitly chooses both.

### Library

There is one corpus with three primary states:

- Inbox
- Later
- Archive

Then filters and saved views:

- format;
- collection;
- topic/tag;
- creator;
- duration;
- downloaded;
- subscription/feed.

Books, Podcasts, Videos, PDFs, and Feeds are useful filters, not permanent
navigation destinations. The list remembers its query, scroll position, and
selected filters.

The first few frequently used Saved views appear as a horizontally scrollable
row at the Library root, for example `All · Books · Audio · Video · PDFs`.
Opening a format therefore remains two moves from anywhere: Library, then the
view. Custom queries live behind Filters rather than turning into configurable
top-level navigation.

Library owns Collections, tags, Saved views, and membership editing. Notes and
Search consume those projections; they do not create competing organization
systems. Capture can choose a static Collection, never a Saved view.

A followed feed is a passive acquisition stream, not Inbox. Following items
appear in a Library Saved view and enter Inbox only when explicitly saved.
Subscriptions are omitted from the first prototype so a passive stream cannot
quietly recreate unread pressure.

Rows expose only identity, progress, duration, and one state action. Swipe may
accelerate Later/Archive. Overflow handles secondary filing. Bulk curation is
available but not allowed to dominate the default mobile surface.

### Notes

Notes is the thinking surface:

- Recent
- Pinned
- Highlights
- Tags
- Recent correspondence
- New note

A highlight is evidence, not yet necessarily a thought. Adding interpretation
creates a Note that cites the highlighted Passage.

Backlinks and connections belong inside a Note. A graph can be an optional
analysis view, never the primary navigation metaphor.

There are two writing tempos:

- **quick thought**: a compact composer over the current context;
- **deliberate composition**: a full-screen page with its own history.

Quick thoughts can promote into pages without losing their source quote,
draft, or return path.

### Search

Search is a full-screen destination and the application's universal door:

- search everything;
- open by title;
- recent items and queries;
- filter by object, format, creator, collection, or time;
- ask across selected scope;
- start a known action.

The first result set is lexical/local and immediate. Semantic retrieval may
blend in as available. “Ask” is an explicit promotion of the query, with the
selected scope shown before submission.

On a desktop the same capability can project as a command overlay. On a phone,
it is a stable bottom-reachable destination that becomes a focused search
screen when the keyboard opens.

The Search tab is always corpus-global. “Find in this Source” begins from the
reader or player, pushes a scoped Search route in the current stack, and Back
returns to the exact source locator. It does not mutate hidden global scope.

Active and recent AI correspondence appears at the top of Search recents and
under Notes' Recent correspondence view, so resuming it is two moves away.
“Ask these” is deliberately a longer, less-common flow: enter multi-select in
Library/Search or invoke Ask on an existing Collection, inspect the scope, then
submit.

### Capture

Capture is available from:

- the operating-system share sheet;
- the labeled **Add** action on Home and Library;
- Search's initial action list;
- paste;
- URL;
- file/photo/scan;
- voice thought;
- subscribe.

Add always opens the same short chooser: `Link · File · Thought · More`. It
never guesses a different primary action from clipboard contents. Link and
Thought focus an input only after selection; File opens the system picker;
More contains scan, voice, and subscribe. This is predictable and completes
the common choice in two moves without pretending a naked plus has one meaning.

Capture confirms safety immediately, then performs extraction and enrichment
asynchronously. It does not make the user watch a pipeline.

The default result is Inbox. Optional actions are Read now, Add to Up next, and
Choose collection.

The capture receipt is durable and has an inspectable state: Saved, Processing,
Ready, or Needs attention. Failure retains the original input and offers Retry
or Remove; it never turns a failed extraction into a vanished capture.

Inside a full-screen artifact, contextual capture takes precedence: selection
creates a highlight or note, and the player creates a timestamped note. Generic
capture remains under More instead of permanently covering the work.

## The common loop

```text
Capture → Inbox → Choose → Consume → Mark → Interpret → Connect
   ↑                                                   │
   └──────────── Search / Ask / Resurface / Reuse ─────┘
```

Each stage produces durable value even if the user stops there:

- capture preserves the Source;
- choose records intent;
- consume preserves progress;
- mark preserves a Passage;
- interpret creates a Note;
- connect places it in the corpus;
- ask can produce a cited, promotable artifact;
- resurface brings durable thought back into use.

## Reading

The reader is an editorial canvas.

### Default anatomy

- content occupies the full useful width and height;
- Back, compact identity/progress, and More form the top chrome;
- Contents, Annotate, Ask, and typography form the bottom controls when shown;
- chrome retreats with clear reading intent and returns on upward motion or tap;
- selection uses native handles and a compact contextual action bar;
- returning to a source restores the exact Passage and briefly emphasizes it
  without moving the page.

When selection becomes stable, the reader's single bottom contextual toolbar
becomes:

```text
Highlight · Note · Link · Ask
```

This is not a tiny pill beside the selection. Four evenly spaced, labeled,
44–48 point actions fit in the reader-owned bottom region without competing
with selection handles. Copy, Look Up, Share, and other platform text actions
remain available in the native edit menu. At large text sizes the Annotate
control opens the same four actions as a vertical list instead of compressing
labels.

The same actions are reachable from the reader's visible Annotate control and
keyboard commands. This provides a path for screen-reader users, PDF/OCR
regions, timed media, and content where native text selection is unavailable.

Highlight uses the last style in one tap, then offers a quiet reversible
confirmation:

```text
Highlighted · Add note · Undo
```

Note opens a keyboard-ready composer with the source quote visible. Link opens
a target search. Ask opens a short grounded prompt with the quote attached. A
long note or answer promotes to a full-screen route.

### Text system

- default reading face: a screen-optimized literary serif such as Literata;
- interface face: the platform system sans;
- user-adjustable size, measure, line height, weight, theme, and scroll/paging;
- Dynamic Type or equivalent scaling is foundational;
- light mode is warm paper and strong ink;
- night mode is a separately tuned cool press, not a color inversion;
- source-authored hierarchy is retained when it helps comprehension;
- reading width remains comfortable on larger phones and tablets.

The typography must remain calmer and more legible than the source website. If
it does not, the reader has failed.

### Format experience profiles

Cross-format unity means shared identity, continuity, annotation, and search.
It does not mean forcing incompatible media through one gesture model.

| Profile | Primary interaction | Specific rules |
| --- | --- | --- |
| Reflowable text / HTML | Vertical scroll | First prototype profile; no paging option initially |
| EPUB | Reflowable scroll first | Chapters and CFI/text fallback; paging may come later |
| PDF | Native page geometry, pan, and zoom | No custom horizontal navigation gesture; page/region locators; reflow view when available |
| Transcript | Synchronized vertical text | Auto-follow pauses on manual scroll; timestamp remains visible |
| Audio | Background playback | Platform transport/interruption behavior; timed annotations |
| Video | Inline or full-screen playback | Explicit landscape/full-screen, captions, scrubbing, PiP, and audio-description support |

The 80/20 proof ships only scrolling reflowable text. Supporting a format means
passing that profile's restoration, accessibility, and annotation gates—not
merely rendering its bytes.

## Listening and watching

Playback is continuous across navigation.

### MiniPlayer

When media is active, a compact accessory sits above or attaches to the tab
bar. It shows:

- source identity;
- play/pause;
- compact progress;
- one predictable expansion action.

It never traps navigation and never pretends playback stopped when the user
opens another part of the app.

### Now Playing

Now Playing is a full media mode, not a generic drawer:

- artwork or video owns the upper field;
- transport, speed, output, and note controls occupy the reachable lower field;
- chapters, transcript, queue, and details are subordinate routes or short
  sheets;
- system media controls, interruptions, background audio, and Picture in
  Picture behave as the platform expects.

A timestamped Note records Source, time range, transcript excerpt where
available, and the user's thought. Manually scrolling a following transcript
pauses auto-follow and offers an explicit “Return to current.”

Reading and listening are alternate representations of one Source when
alignment exists. Moving between them transfers a semantic location, never a
raw DOM pixel.

## AI and conversation

AI has four entry shapes:

1. **Ask this** — a selected Passage or media moment.
2. **Ask here** — the current Source.
3. **Ask these** — an explicit set of Sources, Notes, or Collections.
4. **Ask everything** — corpus search promoted from the Search tab.

The compact ask composer shows its scope before submission. It may offer a few
stable intents such as Explain, Challenge, Compare, or Connect, but never a
rotating prompt carnival.

Submitting always promotes the composer into a full-screen correspondence.
The app never decides mid-response to move the user into a different surface:

- the source scope stays visible and inspectable;
- citations open as previews, then exact source locations;
- Back returns to the originating artifact and position;
- streaming stops auto-following after the user scrolls away;
- Stop, Retry, and follow-up controls remain close to the composer;
- drafts and run state survive interruption;
- source use, tool actions, cost, and machine identity are inspectable.

Conversation is useful working memory, but not the final knowledge form. A
response becomes durable corpus material only when promoted to a Note or
artifact with citations and machine provenance.

AI tools call the same typed domain commands as the human interface. Mutations
are origin-marked, reversible where possible, and risk-tiered with preview and
approval otherwise. Machine writing never silently merges into human prose.

## The surface grammar

There is no universal Drawer.

| Intention | Phone surface |
| --- | --- |
| Switch top-level worlds | Persistent bottom tab bar |
| Navigate deeper or work for a while | Full-screen push route |
| Act on a visible object | Anchored action bar/menu |
| Inspect, choose, or briefly edit context | Bottom sheet |
| Confirm a consequential decision | Alert/dialog |
| Preserve ongoing playback/task | Ambient accessory/MiniPlayer |

### Bottom sheets are for

- contents and chapters;
- quick note;
- playback speed;
- short filter and sort choices;
- choose collection;
- source preview;
- simple contextual details.

They have one useful resting height by default, one obvious close control,
swipe-to-dismiss where safe, keyboard and safe-area ownership, and no internal
application hierarchy.

The shared interaction chassis owns portal placement, top-layer arbitration,
inert underlays, focus containment and return, scroll lock, keyboard/visual
viewport, safe areas, Back/Escape integration, presence, gesture settlement,
and reduced motion. A semantic sheet owner still owns its title, state,
dismissal safety, initial focus, and whether scrim or swipe dismissal is
allowed.

Sheet behavior is explicit:

- only the top modal surface is interactive and announced as modal;
- initial focus moves to the task title or first meaningful control;
- Back and the visible close control request the same guarded dismissal;
- scrim and swipe dismissal are disabled while work could be lost;
- keyboard appearance expands usable sheet geometry without covering focus;
- a canceled drag settles to rest; distance or release velocity may commit;
- drag progress and scrim opacity follow one normalized value;
- reduced motion keeps every input path and replaces travel with brief fades;
- a draft is committed locally before a safe sheet reports completion.

When a quick task acquires subnavigation or sustained composition, an explicit
Expand action performs a transactional handoff: persist the task/draft ID and
origin locator, replace the sheet with a full-screen route, restore focus in
the route, and keep one Back path to the origin. Nested sheets are never the
promotion mechanism.

### Full-screen routes are for

- reading;
- Now Playing;
- writing and editing;
- Search results;
- long AI correspondence;
- document maps;
- queues and large collections;
- transcript or evidence exploration;
- any task that acquires subnavigation.

### Phone surfaces never include

- primary sidebars or hamburger navigation;
- nested sheets;
- a modal containing an app within the app;
- a persistent inspector;
- a command palette floating above the keyboard;
- edge-swipe-to-open custom navigation;
- a drawer variant chosen only because its animation is reusable.

### Bottom-region arbitration

There is one bottom-region owner and this precedence is non-negotiable:

1. The system keyboard and safe area define the available viewport.
2. A modal sheet owns the available bottom edge; root chrome beneath is inert.
3. A full-screen artifact hides root tabs and the MiniPlayer and owns one
   contextual toolbar above the safe area or keyboard.
4. A root destination shows the tab bar plus at most one attached accessory:
   the MiniPlayer.
5. Add/Capture is a labeled action inside the active root toolbar or content;
   it never creates another persistent bar.

When the keyboard opens on a root destination, the MiniPlayer collapses out of
the visual stack while playback continues through system controls; the tab bar
remains stable if the platform provides room. Large text can increase bar
height, but never introduces horizontal scrolling among primary tabs.

On tablets and wide windows, the same semantic capabilities adapt:

| Phone | Tablet / wide window |
| --- | --- |
| Bottom tabs | Sidebar or navigation rail |
| List then detail | List + detail |
| Full-screen support route | Supporting pane beside artifact |
| Bottom sheet | Sheet, popover, or supporting pane by task |
| Full-screen Search | Search/results + preview |
| MiniPlayer + Now Playing | Persistent media accessory/pane where useful |

Mobile and tablet share state, objects, and actions—not rigid geometry.

## Interaction laws

1. **Causal motion.** A quote becomes the quote chip. A MiniPlayer expands from
   its actual location. Closing returns attention to the origin.
2. **Interruptible motion.** A new touch takes control immediately.
3. **Direct manipulation.** Drag progress drives the surface and scrim
   together; cancellation settles instead of teleporting.
4. **Brief motion.** Frequent actions use press states and subtle feedback, not
   ceremonies.
5. **Spatial consistency.** A surface exits toward the place it came from.
6. **No layout animation on gesture paths.** Use transforms and opacity.
7. **Reduced motion preserves meaning.** Replace large movement with fades,
   emphasis, and immediate transitions; never remove the input method.
8. **Haptics mark commitments.** Highlight created, queue committed, sheet
   settled—not every tap.
9. **System gestures win.** The application does not compete with Back, Home,
   notification, selection, or browser gestures.
10. **Visible alternatives.** Every drag or swipe action has a single-pointer
    control or menu equivalent.

## Accessibility is interaction design

Accessibility behavior is specified with each surface and enforced globally:

- touch targets are at least 44 points on iOS-shaped projections and 48 dp on
  Android-shaped projections, with visible press states and adequate spacing;
- text reflows without horizontal application chrome at 200% equivalent
  scaling; truncation never hides the only identity or action;
- tab labels, toolbar actions, and Voice Control names remain stable and match
  visible labels;
- every full-screen route receives a unique heading and logical focus entry;
- modal surfaces isolate background content and restore focus to their origin;
- streaming AI announces meaningful completed blocks, never every token;
- highlight colors also differ by underline/edge treatment and accessible name;
- timed media supplies captions/transcript when available and preserves system
  caption/audio-description choices;
- Annotate exposes a non-drag, non-selection route to the visible Passage or
  current media time;
- focus indicators use a dedicated high-contrast token, not the brand accent
  alone;
- reduced motion preserves hierarchy through fades and emphasis;
- high-contrast mode replaces translucent materials with opaque surfaces and
  explicit borders.

Large text, TalkBack/VoiceOver, Switch/Voice Control, keyboard-only use,
reduced motion, color differentiation, zoom/reflow, captions, and orientation
are acceptance modes, not cleanup passes.

## Art direction: the quiet press

The visual goal is not “AI app,” “productivity dashboard,” or “glass UI.” It
is a beautifully made edition that happens to be alive.

### Materials

- **Canvas**: near-paper neutral with a small amount of warmth;
- **Surface**: one lifted paper tone for bars, sheets, and menus;
- **Ink / muted ink / hairline**: three explicit contrast roles;
- **Link/brand accent**: navigation links and selected controls only;
- **Machine ink**: a cool secondary hue plus attribution, never color alone;
- **Danger**: reserved for destructive or failed state;
- **Focus ring**: independent high-contrast outline token;
- **Highlights**: a small semantic set using fill plus underline/edge pattern;
- two or three elevations at most;
- translucency only when preserving visible context helps orientation;
- hairlines, spacing, and typography before cards and shadows.

The default light palette should pass contrast before translucency is added.
The night palette is separately authored around a blue-black canvas and warm
light ink. High contrast is a third recipe, not a stronger shadow.

### Grid and type

- 4-point base grid;
- spacing rhythm: 4, 8, 12, 16, 24, 32, 48;
- root horizontal margin: 20 points on compact phones, 24 on large phones;
- reading measure: roughly 32–38 characters at the default size on compact
  phones, expanding only until line length remains comfortable;
- reading body: approximately 19/30 at the default setting, always adjustable;
- interface body: 15/20; metadata: 12/16; section label: 12/16 with restrained
  tracking; title: 24/30; display: 32/38;
- system sans for controls; screen-optimized literary serif for long reading;
- one icon family with platform-familiar metaphors and consistent optical
  weight.

Dynamic type changes the scale and may simplify layouts. It does not merely
make text overflow fixed containers.

### Shape

- avoid nesting rounded rectangles inside rounded rectangles;
- reserve capsules for compact actions and state;
- lists read as editorial rhythm, not a pile of tiles;
- media artwork can break the typographic field, but decoration cannot;
- controls have a visible press state and at least a 44–48 point hit region;
- icons gain labels whenever meaning is not universally obvious.

### Surface recipes

- **Root list**: canvas, typographic section heads, hairline or whitespace
  separation, almost no cards.
- **Reader**: uninterrupted canvas; chrome sits on a single quiet material and
  disappears as one system.
- **Sheet**: one lifted surface, 20-point top corners, visible task title and
  close control, no cards nested merely to create depth.
- **Note**: page typography with citations as marginal chips/rails, not pills
  around every block.
- **Machine output**: readable prose, cool attribution rail, cited spans, and a
  collapsed colophon.
- **Media**: artwork may own color locally; controls remain in the global ink
  system rather than sampling an unreadable theme.

### Human and machine voices

Human-authored text and source text remain the primary register. Machine text
uses a subtle attribution rail, cooler ink, and a visible origin mark. It does
not use neon gradients, sparkles, robotic avatars, or fake handwriting.

Honesty becomes ornament: model, sources, actions, and timestamp form a quiet
colophon when requested.

### Character

The app can be futuristic without being loud:

- exact transitions between a source and its evidence;
- a selection that physically becomes a note citation;
- audio and text that hand off at the same idea;
- a note that remembers where it came from;
- a search result that opens on the exact sentence;
- an assistant that can file the result under visible provenance;
- the user's past thought returning once, at the right time.

The magic is continuity and intelligence, not visual effects.

The signature transition is **source becomes thought**: the selected Passage
briefly anchors in place while a matching citation strip appears in the quick
Note; expanding the Note carries that strip into the full page. Closing
re-emphasizes the original Passage. Reduced motion uses a matched highlight
fade rather than geometric travel.

## Systems architecture

The durable center is a local-capable resource and annotation system. UI,
search, graph, and AI are projections.

```text
phone / tablet / web
  local working set + blob cache + search subset + outbox
                         │
            cursor sync / idempotent commands
                         ▼
sync/API boundary → canonical relational store → object storage
                              │
                    transactional change log
                       ┌──────┼──────┐
                    ingest  indexes  AI jobs
```

### Two deliberately different source-of-truth modes

The **prototype** is server-canonical. Its visible state is:

```text
last acknowledged server snapshot
  + atomically committed local unapplied commands
  = current optimistic materialized view
```

The durable local outbox is a command source, not a disposable cache. “Saved”
means the local materialized change and its outbox command committed in one
transaction. It does not falsely imply that another device has acknowledged
the change.

The **north star** may become a bidirectional local replica when corpus-wide
offline use justifies it. That is a distinct architecture decision, not a
gradual relabeling of the cache.

### Navigation-state ownership

The navigation coordinator composes, but does not conflate:

- canonical deep-link state: Resource + optional Context reference;
- ephemeral per-tab history: device/session local;
- persisted task session: bounded, schema-versioned, migratable, and safe to
  discard if invalid;
- durable domain draft: Note, correspondence input, or capture command;
- transient interaction layer: never canonical URL state.

Feature code requests semantic navigation and supplies an origin. It does not
mutate tab stacks, browser history, overlay history, and focus independently.

### Storage rules

The full north-star sync protocol is:

- stable Resources point to immutable Representations;
- original and Derived-artifact blobs are content-addressed independently;
- annotations target versioned Locators with redundant selectors;
- reanchoring records confidence and never erases the original anchor;
- a local mutation and its outbox command commit atomically;
- the client retries an idempotent command until a durable acknowledgement;
- one server transaction validates the base version, applies current state,
  records the idempotency result, and appends the change-log entry;
- replaying an idempotency key returns the original result while its retention
  window is valid;
- clients pull changes after an opaque cursor and apply the page plus cursor
  advance atomically;
- an expired cursor forces an explicit full snapshot resync;
- deletes become tombstones for a retention window;
- tombstones are collected only after the supported offline horizon and
  registered-device/cursor policy make resurrection impossible;
- search and graph projections can always be rebuilt from canonical data;
- export includes sources, notes, annotations, links, progress, and AI lineage.

Cursor, idempotency, and tombstone retention windows are one coordinated
offline contract. A client may not claim indefinite offline sync unless the
server retains enough history to honor it.

The 80/20 proof implements only the Highlight, Note, and progress commands plus
the server snapshot needed by that loop. General cursor replication, device
registration, tombstone collection, and full-resync machinery remain
north-star work until another slice exercises them.

### Conflict policy

Do not use a CRDT everywhere.

- imported metadata follows source versions; user overrides are separate;
- highlights, links, and memberships use identity plus tombstones;
- scalar preferences can use server-versioned last-writer-wins;
- progress commands distinguish checkpoint, explicit seek/rewind, and
  completion and carry a server base version; progress is never merged with
  `max()`;
- note conflicts create inspectable revision copies in the prototype;
- ordered queues use stable fractional positions and deterministic ties.

A text CRDT becomes justified only after simultaneous multi-device editing is a
demonstrated behavior.

### Search

- local lexical search immediately covers cached titles/text, recents, local
  Notes/Highlights, and pending mutations;
- corpus-wide results remain server-backed until a full local index exists;
  offline Search labels its available scope instead of pretending to search
  everything;
- server lexical and semantic search share the same versioned chunks;
- ranking blends exact/lexical relevance, semantic similarity, recency,
  explicit intent, and resource diversity;
- every result resolves to a Context reference;
- index versions record extractor, chunker, embedding model, and schema;
- local pending changes overlay server results.

PostgreSQL full-text search plus a vector extension is enough until measured
scale proves otherwise. Do not begin with a separate search cluster, event
stream, or vector SaaS.

### Reader adapters

Format implementations share a capability boundary, not identical chrome:

```text
open
resolve locator
report visible locator
turn selection into locator
extract cited context
navigate
propose locator mappings
```

HTML/text, EPUB, PDF, transcript, audio, and video can differ internally while
preserving the same continuity, annotation, search, and citation contracts.

Adapters return mapping candidates only. A central locator-resolution service
owns confidence, provenance, acceptance, and preservation of the original
anchor. Reading/listening handoff consumes a versioned alignment Derived
artifact; it is never guessed independently by two clients.

### Capture and offline trust boundaries

Remote and uploaded content is hostile until proven otherwise:

- URL fetching blocks private-network/metadata targets, validates redirects,
  limits egress, and records provenance;
- file intake enforces size, declared and detected MIME, archive limits,
  malware policy, and sandboxed extraction;
- scan and voice ingestion retain original-source lineage and explicit
  permission state;
- generated previews and HTML render under a constrained content policy;
- enrichment workers receive capability-limited blob references.

Offline blobs have explicit integrity hashes, per-class quotas, eviction
priority, download state, range/resume behavior, credential boundaries, and
logout/revocation cleanup. Licensed or provider-controlled media can opt out
of durable offline storage. Offline media is its own product slice.

### AI

- context assembly accepts explicit Context references, permissions, token
  budget, freshness policy, and provenance;
- retrieval returns versioned spans, not detached strings;
- stored Context references are reauthorized at retrieval and tool-execution
  time;
- tools are typed commands and queries behind the same authorization and
  idempotency boundaries as UI actions;
- agent runs are cancellable jobs with typed public state;
- persist model/version, prompt-template version, context references,
  citations, tool inputs/outputs, cost, and final artifact;
- do not persist hidden chain-of-thought;
- suggestion and autonomous mutation are separate capability levels.

Tools have explicit risk tiers:

1. read-only;
2. local reversible write;
3. consequential write requiring preview/approval;
4. external or inherently irreversible action requiring explicit approval and
   a documented compensating action where one exists.

“Reversible” is never claimed for an operation that is not reversible. Tool
logs redact secrets and unnecessary private content and follow a declared
retention policy.

The system must always be able to answer:

1. What data did the machine read?
2. What did it claim?
3. What did it change?
4. How can the user return to the source?
5. How can the change be reversed or compensated, and what approval allowed it
   if neither is possible?

## Delivery strategy

Native quality is a behavior standard, not a framework badge.

For a one-user prototype, do not begin with two native applications or a grand
replication platform. Use one mobile-specific composition, share domain
contracts with the wider system, and add a platform boundary only where an
operating-system capability materially matters. Share targets, background
media, files, notifications, Picture in Picture, and secure credentials are
independent vertical slices, not one thin-shell project.

The north-star local replica can arrive incrementally:

1. canonical server data plus optimistic UI;
2. persistent local working-set cache and mutation outbox;
3. foreground/reconnect cursor sync;
4. explicit offline downloads;
5. only then, a full local relational replica if real use demands it.

Browser background work is opportunistic. The application must not depend on
an idle service worker remaining alive.

For a one-user prototype, target the user's actual primary handset and one
platform integration at a time. In this repository the first physical release
gate is the existing Android target. Share intake is the first native boundary;
background media, notifications, files, Picture in Picture, and secure
credentials remain separate vertical slices rather than one “thin shell” task.

## Quality budgets

These are product budgets, not decorative engineering metrics:

| Experience | Budget / gate |
| --- | --- |
| Local tap feedback | next frame |
| Common local mutation | visible immediately, durable locally before success |
| Warm root transition | no blocking network dependency |
| Reader reopen | cached shell immediately; exact locator restored |
| Search typing | local results update without network wait |
| Gesture motion | no layout-driven frames; interruptions stay responsive |
| Draft/progress | survives process kill after a committed checkpoint |
| AI answer | cancellable, progressive, citations inspectable while streaming |
| Accessibility | large text, screen reader, keyboard, contrast, reduced motion |
| Offline | open downloaded work, read/play, mark, note, queue, resume |

Instrument:

- open-to-content and open-to-first-action;
- dropped frames and main-thread stalls during gestures;
- accidental dismiss followed by immediate reopen;
- progress/draft checkpoint loss;
- outbox age, retries, conflicts, and duplicate command application;
- restore success;
- exact, reanchored, and orphaned annotation rates;
- search zero-result, reformulation, and result-open rates;
- citation opens, uncited claims, AI action confirmation/undo/failure.

Telemetry is content-free by default. Transmitted events use enumerated action,
surface, timing, count, and error fields—not query text, source text, Note
content, URLs, citations, prompts, or tool payloads. Local diagnostics may
inspect private state on device, are clearly marked, and are never uploaded by
accident. Collection requires explicit consent plus bounded retention and
redaction tests.

Test duplicate, reordered, delayed, offline, clock-skewed, process-killed, and
interrupted conditions. A release candidate must also be used on a real phone
with one hand, keyboard open, large text, screen reader, reduced motion,
incoming media interruption, rotation, and slow connectivity.

## The true 80/20 prototype

Prove one loop for one format on the actual primary Android handset:

```text
open one reflowable text Source
  → restore exact locator
  → select a Passage
  → Highlight or write a cited Note
  → leave or kill the app
  → reopen Home
  → Continue at the exact Passage with work intact
```

That requires only:

1. one scrolling HTML/text reader profile;
2. one stable Representation + text Locator contract;
3. native selection plus Highlight, Note, and accessible toolbar alternatives;
4. one quick-Note sheet that can promote to a full-screen route without
   changing the Note ID;
5. one navigation/return owner for origin, Back, and exact resume;
6. server snapshot + atomically durable local materialized change/outbox;
7. foreground retry-until-ack for Highlight, Note, and progress commands;
8. process-kill, offline-write, large-text, TalkBack, reduced-motion, and
   real-device proof.

It explicitly does **not** require the four-tab shell, OS share intake, audio,
video, PDF, EPUB, corpus-wide offline Search, graph exploration, AI tools, a
full local replica, or generic format adapters. Build only invariants exercised
by this loop.

### Product skeleton after the proof

Add each as a separately releasable vertical slice:

1. four stable tabs and the navigation law;
2. Home with Continue, Up next, and Inbox;
3. Library with Inbox/Later/Archive and visible Saved views;
4. Notes root, backlinks, and source return;
5. corpus Search, then explicit Ask promotion;
6. Android share intake and labeled Add chooser;
7. audio session, MiniPlayer, Now Playing, and timed Note;
8. remaining format profiles one at a time;
9. explicit offline downloads as their own secure slice;
10. typed AI tools only after cited Ask and undo/approval contracts are proven.

Do not build yet:

- phone side navigation;
- configurable tabs;
- per-format top-level sections;
- an AI/chat tab;
- nested or multi-detent sheets;
- a graph-first browser;
- CRDTs;
- event sourcing;
- OpenSearch or a vector service;
- background autonomous filing;
- social/collaboration features;
- gamification;
- a recommendation feed;
- a plugin platform;
- a universal drawer;
- separate mobile and desktop domain models.

## Sequence

### Act I — continuity

Ship the one-format 80/20 proof: exact resume, Highlight, cited Note, safe
sheet-to-route promotion, return to source, and durable local outbox.

If this loop does not feel immediate and trustworthy, nothing more advanced
matters.

### Act II — the pocket library

Ship the four-tab shell, Home, Library states, Search, Notes root, Add/share
intake, and the deterministic navigation law. Keep one reader format.

### Act III — the ear and other pages

Ship background audio, MiniPlayer, Now Playing, timed Notes, then PDF, EPUB,
transcript, and video as individually gated experience profiles.

### Act IV — intelligence and return

Ship explicit-scope Ask and citations, then approved tool tiers, promotion from
correspondence to Notes, one deterministic resurfaced thought, and cross-source
connections. The machine gains hands only after the system can show what they
did and compensate where possible. Do not ship a feed.

## The steal ledger

Steal mechanisms, not skins.

| Source | Steal | Refuse |
| --- | --- | --- |
| Kindle / Apple Books | artifact sovereignty, native selection, exact resume, aggregate annotations | store-shaped chrome around every page |
| Readwise Reader | unified cross-format corpus, Inbox/Later/Archive, annotation continuity | power-user configuration density on the default phone surface |
| Spotify / Apple Music | continuous playback, MiniPlayer, full Now Playing | turning Home into engagement inventory |
| Things / Apple Quick Note | fast capture, shallow predictable completion, source-aware quick thought | filing requirements before capture |
| Apple Notes / Bear | quiet writing, inline links, familiar formatting | exposing database machinery during composition |
| Obsidian | portable thought, backlinks, user-owned graph | graph-as-home and plugin-driven IA |
| Superhuman | decisive triage verbs and reversible velocity | inbox-zero guilt as product motivation |
| ChatGPT / Claude | one-box access to a capable interlocutor | chat as the only durable form and AI as a destination everywhere |
| Maps / platform sheets | direct manipulation and context-preserving short tasks | nested sheets and modal applications |

## Council decisions and dissent

The council converged on:

- no phone sidebar;
- three to five stable bottom destinations;
- one cross-format Library;
- content-first immersive reader/player;
- one surface grammar chosen by task depth;
- continuity and local safety before sophisticated AI;
- AI scope, citations, provenance, approvals, and undo/compensation boundaries;
- a small ontology and rebuildable projections;
- no universal drawer.

One lens proposed Conversations as a top-level tab. The stronger decision is
not to do that initially. Conversation is a working form that begins from
Search, a Passage, a Source, or a Note. If measured daily use later proves that
long-lived conversations are a peer world, a tab can replace—not join—one of
the existing four. The default must not pre-commit the product to chat as its
primary metaphor.

## Questions that govern every future feature

1. Which human intention does this serve: capture, choose, consume, mark,
   think, connect, find, ask, or return?
2. Is it acting on the current object, switching worlds, or beginning sustained
   work?
3. Must the origin remain visible?
4. Does this need a real history entry and deep link?
5. What state survives interruption, restart, and another device?
6. Can the most common action be completed with one thumb?
7. Is a hidden gesture the only route?
8. Can dismissal lose work?
9. Can the user return to the exact source and position?
10. What happens at large text, landscape, keyboard-open, reduced-motion, and
    screen-reader conditions?
11. Is motion explaining causality or decorating?
12. Is AI serving the present intention or inventing a new interruption?
13. Can every machine claim and mutation show its scope, provenance, approval,
    and undo or compensation boundary?
14. Would this become a supporting pane rather than a larger drawer on tablet?
15. Is the feature valuable enough to spend scarce attention on Home?

## External design and systems references

- [Apple tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
  and [sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars):
  stable compact navigation on phones; adapt to sidebars on wider layouts.
- [Android layout and navigation
  patterns](https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-and-nav-patterns):
  three to five compact destinations and adaptive navigation.
- [Apple sheets](https://developer.apple.com/design/human-interface-guidelines/sheets)
  and [modality](https://developer.apple.com/design/human-interface-guidelines/modality):
  scoped tasks in sheets; sustained or deep tasks in full-screen experiences.
- [Apple motion](https://developer.apple.com/design/human-interface-guidelines/motion),
  [buttons](https://developer.apple.com/design/human-interface-guidelines/buttons),
  and [typography](https://developer.apple.com/design/human-interface-guidelines/typography):
  purposeful interruptible motion, 44-point hit regions, and accessible type.
- [Apple generative
  AI](https://developer.apple.com/design/human-interface-guidelines/generative-ai):
  use AI for specific value, identify it clearly, preserve control, and offer
  Retry, Edit, Undo, or other recovery where appropriate.
- [Apple Books
  annotations](https://support.apple.com/en-ie/guide/iphone/iph17bf340c1/ios),
  [Apple Notes links](https://support.apple.com/en-euro/guide/iphone/iph908d1558b/ios),
  and [Apple Music
  playback](https://support.apple.com/guide/iphone/play-music-iph0138fb328/ios/26):
  contextual marking, inline source relationships, and continuous media.
- [WAI WCAG 2.2 input
  guidance](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/):
  visible single-pointer alternatives for dragging and adequate target size.
- [Readwise Reader](https://docs.readwise.io/reader/docs) and its
  [Library configurations](https://docs.readwise.io/reader/guides/workflows/library-configuration):
  one cross-format reading system and explicit triage models.
- [Android offline-first
  architecture](https://developer.android.com/topic/architecture/data-layer/offline-first)
  and [Ink & Switch local-first
  principles](https://www.inkandswitch.com/essay/local-first/):
  immediate local work, user ownership, and asynchronous network replication.
- [W3C Web Annotation Data
  Model](https://www.w3.org/TR/annotation-model/):
  body/target annotations and resilient text or timed-media selectors.
- [PostgreSQL full-text
  search](https://www.postgresql.org/docs/current/textsearch.html) and
  [pgvector hybrid search](https://github.com/pgvector/pgvector#hybrid-search):
  an adequate one-user lexical/semantic search substrate before a separate
  search platform is justified.

## If only one thing

Perfect this loop:

```text
open → exact resume → select a passage or moment → make a thought
     → leave → return to the exact source
```

That loop is the entire product in miniature. It proves content sovereignty,
continuity, annotation, provenance, mobile ergonomics, and trust. Everything
futuristic can grow from it. Nothing futuristic can compensate if it is bad.

## Provenance

Written from a clean-sheet council across information architecture, mobile
interaction/editorial design, and platform systems, followed by an integrative
product-architecture pass. The council was instructed to ignore current Nexus
implementation details. Current platform and primary technical sources were
used to test the recommendations; final choices are product judgment, not
consensus-by-citation.
