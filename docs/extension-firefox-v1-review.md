# firefox capture v1 review

2026-09-23 · research record; not an implementation contract

the approved direction is specified in [the implementation plan](extension-firefox-v1-plan.md).
that plan supersedes this review where they differ, including firefox minimum,
background lifecycle, upload composition and the exclusion of fallback paths.

scope: desktop firefox, ordinary windows, web articles and remote pdf/epub
files. the user does not use containers/private windows and usually obtains
epubs from links. include a right-click link entry. no production code changed;
evidence is source inspection and web research, not live firefox verification.
three independent reviews covered architecture/auth, browser extraction, and
product/interaction design; their conclusions were reconciled against the code.

## recommendation

one capture form, reached from the toolbar or “add link to nexus…”. normal nexus
login when required; source identity; existing library search/multiselect;
explicit “save”; durable confirmation and an “open in nexus” link. use a locally
packaged extension view, a firefox background event page, and the existing
ingestion/library owners. share the browser-safe extraction policy and controlled
chooser; retain environment-specific acquisition, transport and presentation.

the promise is to preserve this document in the selected libraries with minimal
interruption. the hard boundary is what “saved” means: source bytes are durable
and all requested placements have committed. a media row alone is insufficient.
readable publication and indexing may follow asynchronously.

## existing foundation and defects

| evidence | implication |
| --- | --- |
| `apps/extension/content.js:6` clones the live document and runs readability; `popup.js:236-248` posts it | the requested subscriber-page mechanism already exists |
| `apps/web/src/app/extension/connect/start/route.ts:63-105` uses normal login/session recovery | preserve one login product |
| `python/nexus/services/extension_sessions.py:17-45` stores hashed, revocable extension credentials | retain scoped extension credentials; do not copy the web refresh token |
| `python/nexus/api/routes/media_ingest.py:71-145` accepts destinations for article/file/url capture | reuse existing ingress and governance |
| `docs/modules/sharing.md:56-73` makes all implicit and extra libraries additive | zero explicitly selected libraries is valid |
| `LibraryChooser.tsx` is controlled presentation; `LibraryDestinationPicker.tsx` owns web transport and `LibraryChooserSurface.tsx` owns web modal/history behavior | share the chooser at the proper boundary |

the current popup is setup/debug-oriented: base url, connect, capture, forget
token. it has no destinations or link entry. the material gaps are recorded as
separate tickets:

- [login, destinations and link entry](tickets/extension-capture-destination-flow-is-unwired.md)
- [popup owns authentication and transfer lifetime](tickets/extension-popup-owns-auth-and-upload-lifetime.md)
- [firefox permission requests follow asynchronous work](tickets/extension-firefox-permissions-follow-async-work.md)
- [request retries create new identities; replay fingerprints use sizes](tickets/extension-capture-retries-create-new-identities.md)
- [receipt does not prove stored source bytes](tickets/browser-capture-receipt-does-not-prove-source-storage.md)
- [article retry removes required source markup](tickets/browser-article-retry-drops-required-source-artifact.md)
- [extraction and transport failures select the same fallback](tickets/extension-article-capture-conflates-failures.md)
- [entire authenticated dom is transmitted](tickets/extension-capture-retains-entire-authenticated-dom.md)
- [browser/server extraction policies diverge](tickets/extension-extraction-policy-diverges-from-server.md)
- [capture bodies are buffered before bounds](tickets/extension-file-capture-buffers-before-bounding.md)
- [document routing relies on suffixes and head](tickets/extension-document-routing-relies-on-head.md)
- [failed revocation is hidden](tickets/extension-disconnect-discards-failed-revocation.md)
- [extension sources lack static coverage](tickets/extension-javascript-is-outside-static-gate.md)
- [distribution data declaration is absent](tickets/extension-firefox-distribution-consent-is-undeclared.md)

## interaction

1. opening the toolbar form pins the originating tab/document. show title,
   hostname and kind immediately; prepare article extraction locally while
   loading account/destinations. never query a new active tab after login.
2. a link-menu activation pins the actual link plus its originating page/frame.
   it opens the same form. the linked epub/pdf is the target, not its parent
   page. show the link label/filename and destination hostname; avoid exposing
   signed query credentials in ordinary display.
3. if disconnected, continue through the existing hosted login. preserve the
   draft and resume the form. show the connected account unobtrusively.
4. keep all implicit and show the familiar additional-libraries selector.
   empty selection means no additional libraries. default to that empty set;
   retain selections for this interrupted operation. do not silently inherit
   a shared destination from an unrelated previous capture.
5. “save” freezes source, account, destinations and request identity. selection
   before save is a draft. cancel/dismiss before save creates no library item.
   file acquisition can start at save; article extraction need not wait for it.
6. show saving until a trustworthy source-storage receipt arrives. then show
   saved, selected destinations, processing if relevant, and an actual open
   link. popup closure must not be treated as cancellation after submission.

use a compact title/source block, the existing field/chooser visual language,
one primary action, and a small expandable text preview. extraction preview
must render inert text or sanitized content. it offers inspection, not a
“complete article” certification. account/settings stay secondary; base-url
configuration belongs in options/build configuration. support keyboard search,
multi-selection, escape, focus return, status announcements and long titles.
do not import mobile-sheet behavior merely because a popup is narrow.

v1 selects existing libraries. inline library creation stays in the main app;
this keeps the extension credential focused on capture. that is a deliberate
capability reduction relative to the full web chooser, whose controlled create
affordance can be absent without cloning its implementation.

## responsibility and reliability

| owner | contract |
| --- | --- |
| extension form | draft identity, preview, library selection, permission actions, feedback |
| firefox background event page | fixed capture target, hosted auth handoff, submission, operation identity and receipt |
| isolated content script | browser document acquisition and extraction without changing the page |
| shared extraction module | document selection, readability options and metadata policy; no network acquisition |
| extension api adapter | scoped session/destination/status reads and existing capture requests |
| backend source owner | replay, source durability, source processing and truthful receipt |
| library governance/entries | writable destinations, authorization and atomic placement |

use `browser.*` promises and mv3 `background.scripts`. firefox event pages are
not chromium service workers and are not durable storage. persist the immutable
pending payload, account/source identity, destinations and key before submission;
use bounded extension storage suitable for blobs. retain it until storage is
confirmed, then discard redundant local content. reopening resumes observation
or an explicit retry. handle storage quota failure before claiming submission.
this is one capture operation with recoverable state, not an offline sync system.
[mozilla background contract](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background),
[popup lifecycle](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/user_interface/Popups).

keep a stable request key through ambiguous delivery. bind the backend replay
fingerprint to the actual payload/metadata and selected destinations, not only
byte lengths. a replay must not race ahead of source storage. preserve all
immutable browser input artifacts when retrying server extraction. transport
failure retries the same source; it does not silently switch to server scraping.

add only session identity, writable-destination search and owned-capture status
reads to extension authority. call the existing governance/source owners behind
those adapters. no unrestricted api proxy or general library management. make
disconnect distinguish confirmed revocation from local removal.

reuse the controlled chooser, input/feedback primitives and tokens in a local
bundle. adapt data loading and popup layout explicitly. direct `/share` reuse
would require a new privileged bridge for dom/file payloads and has a different
logged-out continuation contract; importing the entire add panel would also
bring unrelated upload/session/workspace behavior. the small bundle/build seam
is the cost of preserving one accessible chooser implementation.

propose firefox 149+ for this prototype: `action.openPopup` can reopen after
async authentication, provided the original browser window is focused. the same
api directly supports a menu-click entry. older firefox releases require a
different continuation presentation; exclude them explicitly rather than adding
another window workflow. this is a proposed minimum, not an observed installed
browser version. permission requests still need a direct user-action handler;
prepare the requested origin before that click.
[popup api](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/action/openPopup),
[version evidence](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/action.json),
[user-action rules](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/User_actions).

## acquisition and identity

for an article, parse the loaded document clone. this preserves subscription
content already delivered to that tab without exporting publisher cookies.
share `node/ingest/article_extraction.mjs` policy, including semantic-main
selection, with the browser. keep server sanitization/canonical-text generation
authoritative: readability is not a sanitizer. retain bounded, inert source
evidence needed for embeds/apparatus, not every inline script, form and account
widget. the current raw-source embed consumer must survive this narrowing.
[readability documentation](https://github.com/mozilla/readability).

for pdf/epub, transfer original bytes. firefox's built-in pdf viewer cannot be
scraped with a content script. use the ordinary page context for an eligible
same-origin link, or extension fetch with the specific required host permission.
use a bounded get and response type/disposition plus server byte validation;
suffixes are hints. do not require head, which some download endpoints reject.
include extensionless http(s) links in the menu. if a purported document returns
a login/landing page, say so and offer opening the link or uploading the downloaded
file. linked article pages that need browser rendering should be opened and
captured there; do not substitute the parent page's readability output.
[content-script limits and request contexts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts),
[menu target data](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/menus/OnClickData).

three identities require separate decisions:

- retrying one submitted operation returns the same acceptance result;
- saving identical content again within one account should reuse that capture
  and add requested memberships;
- capturing changed content produces a new snapshot rather than overwriting
  the annotated original. show an existing-copy indication where relevant.

for v1, use conservative account-scoped exact-content reuse. false negatives
produce extra copies but avoid incorrectly merging distinct editions. never
deduplicate authenticated browser content globally by publisher url. do not
silently replace an existing server-imported teaser with a full private snapshot;
that also changes provenance, visibility and annotation positions.

capturing rendered text does not guarantee later pages, lazy-loaded sections,
cross-origin frame contents or authenticated images. preserve normal image links;
full asset archiving is outside v1. files retain their embedded resources because
their original bytes are uploaded. local/blob/protected-viewer inputs use the
existing file-upload fallback. no native helper, cookie export or publisher login
automation is proposed.

## product evidence and council disagreements

these are references for particular strengths, not a claim of one universal
best product. documentation establishes advertised behavior; user anecdotes
identify failure modes, not prevalence or the state of current fixes.

| reference | what to borrow, and why |
| --- | --- |
| [readwise reader](https://docs.readwise.io/reader/docs/saving-content) | rendered-browser capture, quick acknowledgement and optional organization; retain accessible content where it exists |
| [zotero connector](https://www.zotero.org/support/adding_items_to_zotero) | recognizable document type, source-aware metadata and destination feedback; acquisition must identify the object correctly |
| [raindrop](https://help.raindrop.io/bookmarks) | icon, collection, save; closest match to this requested commitment sequence |
| [raindrop settings](https://help.raindrop.io/install-extension) | automatic saving is optional; fewer clicks can conceal a destination decision |
| [obsidian clipper](https://obsidian.md/help/web-clipper/capture) | prepare/inspect content before explicit save; make heuristics inspectable without mandatory editing |
| [singlefile](https://github.com/gildas-lormeau/SingleFile/blob/master/faq.md) | distinguish readable extraction from resource-complete archiving; their fidelity/cost contracts differ |

the interaction specialist favors immediate saving, as reader/zotero do. the
privacy and information-architecture reviewers prefer explicit save after
destination selection. choose the latter. a 2024
[zotero forum report](https://forums.zotero.org/discussion/117338/how-to-cancel-adding-item-from-the-web-browser-extension)
describes accidental saving of a sensitive page to a forgotten collection.
one extra click buys visible commitment and scope; do not claim that anecdote
measures the frequency of such mistakes.

the extractor wants the browser snapshot to be authoritative; reliability wants
a fallback. choose explicit source changes: a user can open an unreadable linked
page or choose a clearly labeled url import, but a failed snapshot upload never
silently becomes a server fetch. a
[readwise user discussion](https://www.reddit.com/r/readwise/comments/1i0zygf/save_articles_from_a_site_where_you_are/)
reports clipped subscriber content despite full visible text. this supports
representative manual checks, not a diagnosis of that product's internals.

the archivist wants full source retention and new versions; the privacy reviewer
and annotation owner object to unrelated data collection and silent replacement.
choose bounded article evidence and immutable captures. the cost is less forensic
re-extraction material and possible additional copies of changed pages.

the reuse advocate wants the full existing import surface; the extension engineer
rejects its runtime dependencies. choose one controlled chooser and one extraction
policy, with small adapters around them. sharing at the wrong layer increases
coupling despite reducing apparent duplication.

[keeping found things found](https://www.microsoft.com/en-us/research/publication/keeping-found-things-found-web/)
connects personal keeping practices to reminders and context of relevance. it
supports meaningful placement and easy return to the saved object, not a larger
popup. the 2026
[wcxb benchmark](https://arxiv.org/abs/2605.21097)
finds strong article results but substantial variation on other page types;
its mixed llm/human annotation pipeline and preprint status limit how much to
infer. neither this benchmark nor readability success proves completeness of a
particular subscribed page. no llm extraction pipeline is justified for v1.

## explicit trade-offs and remaining questions

the proposed choices are: firefox 149+ rather than older-browser continuation;
explicit save rather than autosave; no remembered cross-page destinations;
existing-library selection rather than extension library creation; a local ui
bundle rather than hosted capture; reduced source evidence rather than full dom;
exact account-scoped reuse rather than url merging; new copies rather than
silent content replacement; linked images rather than full archives; bounded
recoverable pending state with explicit retry rather than autonomous offline sync;
manual file fallback rather than universal viewer access. these are proposals
for review, not silently accepted scope decisions.

the remaining material product questions are whether authenticated images must
be archived, whether identical-content reuse/new-copy behavior matches the user's
expectation, and whether the proposed minimum firefox version is acceptable.
shared libraries remain valid under existing authorization; selecting one is a
sharing decision and should be identifiable in the chooser. the actual install
path also needs qualification: use a signed package for ordinary persistent
firefox installation, stable extension identity, and truthful current data
declarations. local temporary installation is sufficient for development.
[mozilla data declaration](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## implementation and verification order

1. settle receipt/replay/input-artifact contracts and fix their backend owners.
2. add the firefox background operation owner, permission sequencing and login
   continuation; pin targets across both toolbar and link entry.
3. package the shared extraction policy and controlled chooser; wire scoped
   reads, selected destinations, bounded article/file transfer and accurate states.
4. qualify the complete firefox flow, then package/sign for the chosen install
   route. no deployment, publishing or code work is authorized by this review.

the only automated gate remains `./scripts/test`. when implementation begins,
include extension static coverage there. do not rebuild the retired automated
browser suite. manually observe: first login and resume; denied permission;
public/subscriber article body; source page navigation during login; multiple
destinations and a revoked destination; direct/extensionless pdf; right-click
epub; html returned for a file; source-write failure; response loss and replay;
popup closure/reopen during transfer; browser restart with a pending operation;
article extraction retry; account disconnect failure; and keyboard use.

compare meaningful content, not just status: beginning/end text, article title,
links/apparatus where present, original file bytes, and library membership.
verify no unrelated authenticated markup leaves the browser. use representative
real subscription pages supplied by the user when available. static checks alone
cannot establish these browser/session/storage boundaries.
