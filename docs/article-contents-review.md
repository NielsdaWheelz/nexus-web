# article contents and the shared section picker

status: direction implemented on `feature/article-section-navigation`; verification recorded in the implementation spec
origin: 2026-09-25 council research
source checkout: `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`

the [implementation spec](article-section-navigation-plan.md) owns the approved
behavior and execution plan. this document retains research and rationale.

recommendation: give articles with semantic sections the same compact section
instrument as epubs. derive it from the existing document navigation contract.
retain the inspector outline for overview and hierarchy. the missing capability
is in chrome publication, not article toc extraction.

the user confirmed this scope during review: article headings already appear
in sidebar contents; the desired addition is the pane-bar dropdown. pdfs have
page controls in that bar, while epubs have semantic section controls. article
parity follows the epub section behavior. this clarification defined the later
implementation boundary; the 2026-09-25 follow-up authorized that work.

three parallel reviews covered source structure, reader interaction, and outside
products. their conclusions were reconciled against current source. product
claims below come from documentation and reports, not hands-on testing.

## two controls, two jobs

the compact dropdown and the inspector contents are different controls. treating
them as interchangeable initially concealed the actual gap.

| surface | behavior at research baseline | evidence |
| --- | --- | --- |
| compact section instrument | epub-only previous/next, section counter, native select | `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:5608–5697` |
| full contents | shared web/epub outline, current section, map and excursion return | same file `:6404–6425`; `apps/web/src/components/reader/ReaderDocumentMapDetail.tsx:93–113` |
| current section | already shared; deepest containing semantic range, not last clicked item | `MediaPaneBody.tsx:1983–2002`; `apps/web/src/lib/reader/readerDocumentPosition.ts:125–157` |
| previous/next | already shared ordered destinations, deduplicated by source position | `MediaPaneBody.tsx:4435–4442` |
| source model | articles produce sections and nested toc nodes from retained headings | `python/nexus/services/reader_navigation.py:86–164` |
| offline | both formats have the shared document map; neither has the compact picker | `apps/web/src/offline-reading/OfflineDocumentReader.tsx:694–710` |

the [reader contract](modules/reader-implementation.md) explicitly includes web
articles in inspector contents. the [completed inspector consolidation](reader-inspector-controls-plan.md)
owns one generic inspector disclosure; this proposal does not reverse it.
the compact section picker selects a destination. the inspector button reveals
supporting material and may restore evidence or dossier. those are distinct jobs.

## philosophy and precedents

contents exposes an author's organization. it serves orientation, selective
reading, and return, not merely faster scrolling. the distinction matters:
a compact chooser answers where to go; an outline also shows how the parts
relate. our inference is to keep both existing representations backed by the
same structure and exact destinations.

| precedent | documented behavior | what to borrow and why |
| --- | --- | --- |
| readwise reader | hideable contents panel; september 11, 2026 adds video chapters to the same panel used for article headings | expose document capabilities consistently across formats. [appearance](https://docs.readwise.io/reader/docs/faqs/appearance), [changelog](https://docs.readwise.io/changelog) |
| wikipedia | persistent contents, collapsible descendants, active-section treatment, narrow-width adaptation; research emphasizes document mental models | preserve a full outline for repeated consultation. a transient dropdown alone is insufficient for that job. [design and research](https://www.mediawiki.org/wiki/Reading/Web/Desktop_Improvements/Features/Table_of_contents) |
| safari reader | apple documents contents and summaries for longer pages, without specifying extraction rules | article contents belongs in ordinary reading. this is not evidence that summaries or inferred headings are necessary. [guide](https://support.apple.com/en-gb/guide/iphone/iphdc30e3b86/ios) |
| zotero | the team confirmed current-outline highlighting for pdf and epub in 7.0.11 after a user requested chapter orientation | derive current section from reading position; selected destination alone cannot supply orientation. [request and response](https://forums.zotero.org/discussion/119413/feature-request-document-reader-show-name-of-currently-viewed-chapter) |
| matter | its engineering account describes parser changes causing wider regressions and the value of curated expected output | share the canonical article representation; do not build another extractor inside a widget. its large-scale measurement apparatus is unnecessary for this bounded change. no matter toc claim is established. [engineering account](https://www.getmatter.com/how-matter-approaches-parsing) |

historical readwise users reported [difficulty discovering mobile navigation](https://www.reddit.com/r/readwise/comments/1bu1gdh/how_to_navigate_long_documentsbooks_on_mobile/)
and [unwieldy long outlines and broken internal links](https://www.reddit.com/r/readwise/comments/14qcie8/larger_ebook_navigation_and_internal_linking_is/).
these are anecdotes, not current product audits. they support explicit controls
and dependable targets over hidden gestures and ornamental navigation.

[w3c's toc technique](https://www.w3.org/WAI/WCAG22/Techniques/general/G64)
separates overview from direct navigation and requires correspondence among
entries, section order and destinations. [nielsen norman group's research](https://www.nngroup.com/articles/table-of-contents/)
likewise stresses recognizable labels, destination fidelity, consistency, and
placement appropriate to available space. the
[cockburn, karlson and bederson review](https://faculty.cc.gatech.edu/~stasko/7450/Papers/cockburn-surveys08.pdf)
explains the costs of separating detail from context across space or time.
these support the design rationale; none proves one ideal nexus layout.

## council: questions, disagreements, decisions

these are analytical perspectives from the review, not interviews with named
outside experts.

| perspective | question and strongest objection | recommended decision and cost |
| --- | --- | --- |
| product | why should file format determine access to equivalent navigation? | share the existing instrument by capability. articles gain chrome, including a section count and movement controls. |
| information architecture | does the user need a quick destination or the complete argument structure? | keep the compact picker and full inspector outline. two views remain, with separate purposes and one model. |
| interaction design | why retain a flat native picker when deep trees benefit from hierarchy? | retain the native picker for quick navigation and the existing outline for hierarchy. accept weaker context and platform-dependent handling of long labels in the compact control. |
| accessibility | will reuse preserve native input behavior, focus, full accessible labels and a real destination? | keep the actual native select; no custom menu or tree role. verify pointer, keyboard, mobile and assistive-technology behavior. native semantics reduce implementation burden but do not establish usability. |
| extraction | are apparent headings actually retained source headings? | use nonblank retained `h1`–`h6`. visual-only and aria-only headings remain outside current support; acknowledge incomplete coverage rather than invent structure. |
| systems | who owns the location, excursion and durable reading state? | one section action delegates to existing format positioning and excursion owners. uniform interaction does not require identical source parsing or url syntax. |

agreement should be on invariants and observed outcomes, not votes: every
entry has a real destination; both formats expose the same capability; source
structure has one owner; navigation does not pretend the text was read.

the strongest alternative is a persistent, collapsible desktop outline as the
primary navigator and a richer mobile sheet. that is better for sustained
reference reading but consumes space and demands more interaction machinery.
nexus already has the inspector outline. improving the compact shortcut does
not justify replacing both existing surfaces.

## proposed behavior

1. publish the same instrument for readable web/epub documents with ready
   navigation and at least one section. no word-count or two-heading threshold.
   hide the compact instrument with zero sections; this also cleans up its
   currently unhelpful empty epub form. loading and error remain owned by the
   reader, with no stale previous-document entries.
2. retain previous/next, native picker, and section counter, with a generic
   `section navigation` group name. use the shared section list and current
   section. before or between sections, retain the explicit unselected state;
   never imply that the first section is current.
3. preserve source order, repeated labels and distinct identities. a retained
   title-only heading remains one legitimate destination. this accepts minor
   clutter in exchange for a predictable rule without title-matching heuristics.
4. preserve existing previous/next semantics. from within a section, previous
   reaches that section's start; it does not necessarily select its previous
   sibling. the counter is a section ordinal, not reading completion.
5. use exact anchor/canonical-point positioning through the existing excursion
   owner. selection must not add pane history or generate a reading/completion
   write merely because it moved the viewport. current section follows the
   resulting semantic viewport, including subsequent scrolling.
6. retain full hierarchy in inspector contents. the compact native picker stays
   flat. full option labels must remain accessible; verify long and repeated
   labels on the actual platform. any demonstrated ambiguity is a shared picker
   issue, not grounds for an article-specific widget.
7. hosted mobile uses the same instrument and chrome behavior, including the
   search row's existing precedence. offline retains its shared outline; adding
   a compact offline instrument for both formats is outside this request.

## ownership and implementation boundary

`MediaPaneBody.tsx` owns publication and activation. replace its epub-only
instrument inputs with ready shared navigation. reuse the current native
`Select` and pane toolbar. no extra selected-section state, browser heading
scan, toc endpoint/table, migration, feature flag or replacement control system
is justified. the existing contracts already contain the necessary information.

the action needs care: `navigateToEpubSection` (`:4392–4398`) currently combines
location replacement and the excursion wrapper; `navigateToWebSection`
(`:4417–4424`) serves route restoration and lacks that wrapper. do not attach
the latter directly to the picker. reuse exact section positioning
(`:6345–6352`) and `positionFromDocumentMap` (`:2867–2904`) under one explicit
user-section action, preserving format-specific address settlement. web
positioning already replaces the href with its fragment (`:2805–2807`); setting
an epub-style `loc` first would be overwritten. a deep-link redesign is separate.

article preparation remains in `web_article_structure.py`; navigation remains
in `reader_navigation.py`. stored html and canonical text already suffice.
blank headings are omitted, duplicates receive distinct identities, and skipped
levels do not invent intermediate headings. container boundaries also constrain
hierarchy. source extraction owns removing boilerplate; the picker must not
classify it again.

url import sees fetched html while extension capture sees the live dom. a
missing heading must be traced through source, readable extraction, sanitized
fragment, navigation and chrome. support for `role="heading"` with `aria-level`
would require an explicit capture/ingress change. artificial outlines from
typography or models would be a different product promise.

## findings and follow-up boundary

- missing article picker: the requested capability gap was repaired in shared
  instrument publication; the [spec](article-section-navigation-plan.md) records
  live verification.
- [multiline heading labels](tickets/web-article-contents-truncates-multiline-headings.md):
  `<h2>first<br>second</h2>` retains complete text but the navigation label is
  `first`. fix at the structural/navigation owner, preserving canonical text
  and targets. keep this as a separate narrow correction; it does not require
  delaying pane-bar exposure or expanding that change into ingestion repair.
- [empty contents contract](tickets/reader-empty-contents-availability-contract.md):
  the full inspector publishes even without toc nodes, unlike its prose spec.
  it also contains map controls; do not mechanically apply the compact
  instrument's zero-section rule to this broader surface.
- [authored anchors](tickets/web-ingest-replaces-authored-heading-anchors.md):
  updated existing diagnosis: sanitization strips source targets/references and
  externalizes fragment links before generated heading anchors are added;
  extension capture also strips labelled-by relationships. repairing just
  anchor minting would be incomplete. this does not prevent the generated toc
  from using its own canonical targets.
- [saved cursor replacement](tickets/web-publication-invalidates-saved-reader-cursors.md),
  [initial contents flash](tickets/reader-contents-publishes-after-navigation.md),
  [return drift](tickets/document-map-return-drifts-per-round-trip.md), and
  [physical accessibility acceptance](tickets/reader-map-inert-position-and-mobile-controls.md)
  remain existing issues. parity work must not silently inherit claims that
  those are resolved. do not reimport saved articles merely to expose headings.

## proportionate verification

this research review exercised no browser, device, deployment or production
behavior. source inspection and manual in-memory article-owner observations
establish the stated wiring and multiline-label defect. `./scripts/test` was
not run for this documentation work. the subsequent implementation's live and
static results are recorded in the [implementation spec](article-section-navigation-plan.md).

before implementation, witness the absent article instrument alongside a
populated article navigation response and a visible epub instrument. after
implementation, use a small set of real imported documents covering zero/one
heading, nested/skipped levels, repeated labels, an inline heading break and
long labels. include one ordinary epub as the parity check.

verify exact arrival, current-section tracking during scroll/reflow, boundary
previous/next, no extra history or navigation-caused reading writes, document
switching with no stale entries, and two-pane isolation. check narrow desktop,
hosted mobile, native keyboard/focus behavior, and search takeover/restoration.
verify offline outline remains available. observe return behavior and report
known drift separately; do not label it an exact pass. record actual device and
assistive-technology observations, or explicitly leave them unverified.

the multiline-label fix may justify one small maintained owner regression:
static checks cannot detect a plausible but truncated label, and the reproducer
needs no database or browser. assess that separately under the current testing
contract; do not reconstruct a deleted test suite or add another gate.
