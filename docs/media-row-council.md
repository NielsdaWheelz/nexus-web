**media rows: council review and proposed contract**

status: research retained; direction approved; [implementation contract](media-row-plan.md) is authoritative
origin: 2026-09-26 user request
source baseline: cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1, with pre-existing local changes preserved
method: three independent agent reviews of architecture, domain semantics, and
reference products, plus parent source review. these are disciplinary lenses,
not interviews with named experts. application code unchanged. no browser,
device, database, or production verification was performed.

**judgment.** use one compact media identity everywhere: title, original
publication date, authors, estimated time remaining, processing failure, and the
menu. publisher belongs in metadata. the existing renderer already serves all
the named surfaces; its inputs contradict one another. solve the shared media
contract above it. removing one subtitle would leave most of the defect intact.

the philosophy is selective presentation over a truthful catalogue. a row helps
someone recognize, choose, and resume a work. metadata supports inspection,
attribution, and provenance. the same work should remain recognizable when it
moves between collections. selection, ordering, and occurrence commands can
change without changing that work's identity.

**what the code actually does.** paths below are relative to the repository.

| surface | source evidence | present discrepancy |
| --- | --- | --- |
| quick reads, at hand, library suggestions | `python/nexus/services/media.py:350–407`; `python/nexus/services/resonance/service.py:235–243`; `apps/web/src/lib/resonance/presentSlateItem.ts:35–60` | publisher deliberately becomes subtitle; no authors or processing signal |
| library | `apps/web/src/lib/collections/presenters/media.ts:64–96`; `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:2180–2209` | source hostname appears; sorting by added can replace context with added date |
| lectern | `apps/web/src/lib/collections/presenters/lectern.ts:34–61`; `apps/web/src/lib/lectern/contract.ts:148–184` | authors/date/failure absent; non-audio items receive no time estimate |
| author works | `apps/web/src/lib/collections/presenters/presentContributorWork.ts:27–61`; `python/nexus/schemas/contributors.py:166–172` | current contributor's roles replace the byline; coauthors/time/status are missing |
| search | `apps/web/src/lib/collections/presenters/search.ts:8` | contributors/date/snippet, without the complete time/failure contract |
| browse | `apps/web/src/lib/collections/presenters/browse.ts:63` | source label and reduced facts, including some already-stored media |
| podcast episode lists | `apps/web/src/lib/collections/presenters/episode.ts:46`; `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastEpisodeList.tsx:45` | separate episode policy and offline decorations |

all named collection paths use `CollectionView → CollectionRow → ResourceRow`.
`CollectionRow.tsx:264–289` accepts arbitrary contributor roles and arbitrary
context, so shared rendering has not established shared meaning.

there are two additional publisher routes. `ContributorCreditList.tsx:29–40`
takes the first credits without selecting authors, and the role vocabulary
includes publisher. the media header also publishes every role group
(`media/[id]/mediaFormatting.ts:32–45`); `PaneHeaderIdentity.tsx:65–102` displays
the first groups with role labels. these paths permit publisher credits outside
metadata. their incidence in live records was not measured.

“media info…” is a pane-local action (`MediaPaneBody.tsx:5432–5441`), not a
canonical resource action. its overlay currently shows only title, two
publication dates, publisher, and full contributor groups
(`components/media/MediaInfoOverlay.tsx:14–23,45–106`). it does not fulfill the
requested list-menu entry point or complete metadata view.

**what is worth stealing.** documented behavior and our interpretation are
separated deliberately; none of these products establishes a universal winner.

| reference | documented behavior | what to borrow, and the cost |
| --- | --- | --- |
| [instapaper, july 2026](https://blog.instapaper.com/2026/07/28/instapaper-10/) | condensed list appearance; adjustable typography/thumbnails; desktop side-by-side reader; keyboard access to article actions; optional section counts explicitly described as potentially anxiety-inducing | dense, quiet lists with reachable actions. omit a new appearance-settings system: this user's desired default is already explicit |
| [instapaper's reading-time rationale, 2013](https://blog.instapaper.com/post/61609255324) | time filters help users choose from more saved material than they can read | effort is a decision aid. this historical explanation supports duration, not a claim about the exact current interface |
| [readwise's field semantics](https://docs.readwise.io/reader/guides/filtering/syntax-guide) and [metadata inspection](https://docs.readwise.io/reader/docs/faqs/pdfs) | distinct published/saved/opened/status dates and author/domain fields; metadata accessible in an info surface | preserve independent facts and disclose details on demand. richer metadata does not require richer rows |
| [zotero list columns](https://www.zotero.org/support/sorting) and [zotero 7](https://www.zotero.org/support/7.0_changelog) | default title/creator/attachment columns; richer item details in a separate pane; density choices | bibliography and concise selection coexist. do not import a configurable-column framework for this request |
| [apple books on mac](https://support.apple.com/en-ca/guide/books/-ibks5f526382/mac) and [apple list guidance](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables) | more-menu book details; text lists emphasize scanning and concise content | borrow stable identity and disclosure. store-dependent details do not satisfy imported-media inspection |

[progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
supports moving secondary information behind a clear, reliable entry point.
[pirolli and card's information-foraging paper](https://www.researchgate.net/publication/229101074_Information_Foraging)
models information seeking in terms of value, cues, and acquisition costs. our
application: every field repeated across a list should justify the attention it
costs. these sources do not experimentally validate this exact six-field row;
the user's task and preferences supply that choice.

[brysbaert's reading-rate meta-analysis](https://biblio.ugent.be/publication/8647789)
reports an english nonfiction mean of 238 words per minute and substantial
individual variation. nexus already uses 240. retain its coarse estimate; this
is no warrant for predicting study, annotation, or comprehension time, and no
reason to introduce calibration machinery in this change.

user reports expose competing needs, not population estimates. a
[booktrack request](https://www.reddit.com/r/BookTrack/comments/1fedgr9/feature_request_new_field_and_sort_option_for/)
asks for original-publication dates and matching sorting rather than edition
dates. an [instapaper request thread](https://www.reddit.com/r/instapaper/comments/1kccee3/may_feature_requests/)
asks for publication dates beside reading time; staff acknowledge incomplete
extraction. the same thread asks to move a frequent action out of the overflow
menu. restraint has costs: less provenance during triage and more interaction
for secondary actions. accept those costs explicitly, not by pretending they
do not exist.

**where the council agrees and argues.**

| lens | agreement | hard question or objection | recommended resolution |
| --- | --- | --- | --- |
| product / information design | publisher is secondary to selecting and resuming this user's reading | does source reputation determine selection? | hide publisher/source in rows as requested; preserve them in metadata. accept the extra inspection step |
| bibliography | authors and original publication belong in the identity | are translators, editors, publishers, corporate authors, editions and works being conflated? | author role only in the compact byline; preserve all roles in metadata. a corporate author can legitimately share a publisher's name |
| interaction / accessibility | one recognizable row and one metadata route | does uniformity hide a search match or bury play? | retain one base row; treat search evidence and direct playback as explicit disputed exceptions below |
| architecture | a shared renderer is useful | who owns the facts before rendering? | reuse the current media collection owner, existing contributor/consumption/time owners, and one media presenter |
| reading / reliability | approximate remaining time is useful | is it cursor position, completion, or actual elapsed effort? | use the existing current-resume estimate; never derive time from unrelated completion flags |
| visual design | restrained hierarchy improves scanning | can the title, byline, date, time and menu survive narrow panes and long names? | reflow the same fields; prioritize title and controls; bounded author names; no hover-only access to full details |

**proposed visible contract.** this example communicates hierarchy, not final
pixel geometry:

```text
the title of the work                                …
1925 · author one, author two +2 · ≈15 min left
```

- title is the dominant link. retain native navigation, selection, focus, and
  author-link behavior. the menu stays a separate reachable control.
- original publication retains year/month/day precision. omit unknown values
  in rows. never substitute edition, feed-release, updated, saved, or added dates.
  sorting by added changes order, not the displayed bibliographic field.
- ordered author credits use the existing role vocabulary. show up to two plus
  a truthful overflow count; expose all through metadata. preserve absent
  authorship instead of replacing it with a host, publisher, or unknown role.
  apply the same author selection to the compact media header so publisher
  credits cannot leak there. complete credit groups move independently to metadata.
- known remaining duration renders `≈15 min left`; known total with unknown
  remaining renders `≈25 min total`; wholly unknown time disappears. zero is
  shown only when the authoritative estimate is zero. routine unread, finished,
  percentage, source, and download decorations do not belong in the strict base row.
- failure remains explicit text. keep it and a valid time estimate independently
  representable; offline transfer state must not mask a processing failure.
  routine processing remains visible on opening the item and in imports.
- the row and pane menu both expose `metadata…` with the same data and behavior.
  use the existing desktop dialog/mobile sheet. the menu is a command list;
  it should not itself become a scrolling bibliography.

two authors plus overflow sacrifices complete attribution during scanning for
predictable density. the complete list must be reachable on touch and keyboard,
not merely in a tooltip. unknown omission sacrifices visible completeness for
less repeated noise; metadata makes the absence explicit. desktop and mobile
share semantics, while wrapping and target geometry can differ. use the
[existing menu-button interaction model](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/)
and verify focus return to the actual invoking trigger.

**the semantic decisions that matter.**

1. original publication already means the work's first public publication,
   including serialization; translations and revisions retain that work date.
   an anthology uses its own first publication (`docs/modules/media-metadata.md:8–16`).
   keep this definition. compact episode projections instead use a provider
   release timestamp (`media.py:372–375`), explicitly allowed by
   `docs/modules/player.md:119–123`; the two documents conflict. converge stored
   media on original publication and retain provider release in metadata/scheduling.
   remote previews can expose only the facts they actually have.
2. remaining time belongs to the current durable resume cursor. the owner
   (`services/reading_time.py:16–47`) uses canonical word count / 240 wpm, then
   remaining progression for article/epub cursors, with 1/5/15-minute rounding.
   a positioned pdf has unknown remaining time. moving backward can increase
   the estimate; marking unread does not reset position. finished status does
   not prove zero time at the current cursor. retain these rules and expose
   completion in metadata/menu, accepting that finished items are less obvious
   while scanning. do not add a completion badge without changing the contract.
3. audiovisual duration follows the actual action: listening/watching minutes
   are distinct from transcript reading minutes. label the modality where mixed
   lists need it. use known canonical playback facts and omit unavailable values;
   this task should not invent a video-duration pipeline or a second estimator.
4. failure-only status is coherent if a pending row still opens an informative
   destination. suspended processing is a separate domain state; retain an
   actionable `needs attention` exception only if explicitly accepted. the
   strict default moves that explanation into the opened item. verify this
   cannot leave an unexplained disabled/dead row.

two exceptions deserve a deliberate answer. a search excerpt explains why a
result matched; deleting it makes search worse. an audio play/resume button
performs the queue's primary action; burying it adds a step. the council
recommends allowing search evidence beneath the common identity and preserving
the existing direct playback control for playable audio. both exceed the
literal “that's it” request, so they remain proposals, not silently approved
scope. if strict uniformity wins, remove those extras consistently and accept
those specific costs.

podcast shows and unsaved external catalogue works are different resources.
they cannot inherit fabricated media progress or unavailable menu commands.
all actual stored-media occurrences converge; different resource kinds retain
their truthful contracts. author pages must still show coauthors even when
the page author's identity seems redundant.

**metadata should be complete at the user-facing boundary.**

show title; all ordered credits grouped by role; publisher; original and edition
publication with their real precision; source url and available edition
identifiers; language and description; clearly labelled acquisition/activity
and metadata-update dates; total/remaining duration, current progress and
completion; meaningful processing/recovery details. keep work, edition,
acquisition, and activity dates visibly distinct.

most facts already exist in `python/nexus/schemas/media.py:235–270` and
`apps/web/src/lib/media/mediaDetail.ts:98–134`. stored edition isbn
(`python/nexus/db/models.py:698`) needs a narrow response/decoder addition.
reading estimates compose from their existing owner. label media `created_at`
as record addition/creation, never original publication or a library-membership
date. `updated_at` is record modification, not evidence of an author's revision.
membership and queue-added dates retain their own owners and labels if included.
do not promise dates that were never recorded. “everything” means meaningful
available metadata, not internal database or worker fields dumped into the ui.

**implementation approach after approval.**

1. converge backend list facts around existing `CollectionMedia` and
   `list_collection_media_for_viewer_by_ids` (`services/media.py:304–330,473–585`).
   they already batch-load visible media, credits, read state and capabilities.
   compose canonical reading estimates once per batch. inspect/narrow that
   existing seam rather than add a second summary loader. retire the competing
   publisher-subtitle projection for stored media.
2. existing endpoints still own membership, ranking, pagination, and order.
   queue occurrence ids, author relationships, and library membership stay
   distinct from media identity. add the needed summary to lectern, author,
   slate, and other actual-media results without per-row detail requests or
   changing their eligibility/order semantics.
3. converge actual-media presenters onto one media projection, retaining
   `CollectionView → CollectionRow → ResourceRow`. no per-page field flags,
   arbitrary media subtitle, parallel compact component, or configurable-column
   system. keep non-media and any approved search evidence outside media identity.
4. add metadata to `resourceActions.ts` / `resourceActionMenu.tsx` and the
   existing `resourceOverlaysController.tsx` / `resourceActionRuntime.tsx`.
   move the current overlay there, load details on activation, and remove the
   pane-local duplicate state/action. metadata is read-only; do not copy editor
   mutation machinery into its lifecycle. its data should not depend on pane-header
   presentation types. reuse the current media detail endpoint unless a measured
   need justifies a narrower one.
5. update strict wire decoders with their producers and current docs together.
   lectern/consumption receipts persist outcomes and identifiers, not full
   item snapshots; replay reprojects fresh (`consumption/service.py:249–253,325–334,555–566`).
   adding row facts does not need receipt migration, new persistence, compatibility
   fallbacks, or a feature flag.
6. use existing invalidation/install paths for current values. the library
   status-refresh defect showed that sharing fields alone cannot guarantee
   fresh state. resolve the affected path within implementation; do not create
   another consumption store or event framework.

this is a bounded cross-layer change, not a css cleanup. its cost is several
response/projection updates and a coordinated cutover. that cost buys one place
to understand a media row. persistent data, ranking, ingestion, and estimator
policy need no redesign.

**verification proportional to the change.** after implementation, run only
`./scripts/test` for automated static checks. manually inspect the same eligible
article across library, lectern, author works, quick reads and at hand; queued
items need not appear in at hand because current eligibility excludes them.
check persisted-media search/browse too. use a small set of cases: multiple
roles including publisher; partial/unknown date; unknown/total/remaining/zero
time; manual finished versus cursor position; processing failure; one audio
item; long title and narrow pane. compare row and pane metadata, keyboard and
touch, focus return, queue reorder, and an existing mutation-id replay. confirm
batch network behavior and meaningful refresh after changing reading state.

no new automated suite, synthetic fixtures, benchmark project, or broad release
qualification is warranted here. the narrow-row layout concern should be
resolved by actual visual evidence in that pass. static, browser,
device, and production evidence must remain separate; this review supplies
source evidence only.

**recorded work.** summary divergence, metadata access and completeness, episode
date policy, compact credits and status, library freshness, and narrow layout
were carried into the [implementation contract](media-row-plan.md). that
contract owns their resolution and verification.
