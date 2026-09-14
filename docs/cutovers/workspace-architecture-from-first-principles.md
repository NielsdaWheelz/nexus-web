# a simpler architecture for nexus

> 2026-09-14 pause: historical document; implementation is stopped.
> the [evidence audit](bounded-workspace-evidence-audit.md) distinguishes findings,
> decisions and unverified claims. the [replacement plan](production-crash-replacement-plan.md)
> supersedes this execution scope and awaits user review.

implementation contracts and gates: [bounded workspace implementation](bounded-workspace-implementation.md).

the recommended design is a persistent document workspace with lightweight pane views, published reading artifacts, locally durable pending work, one application api, and isolated background execution. organize modules around what changes together and what must survive together.

the current product already contains much of this shape. its persistent shell, pane visits, publication generations, shared reader sources, cursor concurrency checks, and durable job machinery are assets to preserve. the architectural improvement is to make those boundaries complete. a framework replacement alone would not establish them.

this is a proposed clean-sheet design and migration direction. it does not establish the allocation owner of the production memory kills or predict a measured memory saving.

**the governing distinction**

four objects have different lifetimes:

| object | owns | lifetime and authority |
|---|---|---|
| workspace and pane | arrangement, visits, focus, scroll, selection, inspection state | presentation state; mostly device-local, with an explicitly chosen restore policy |
| document and publication | source identity, readable content, revision, stable locations | imported publications are immutable; authored notes retain their own mutable editing model |
| user work | note drafts, annotations, desired reading position, activity | survives closing a view; server acknowledgment is separate from local persistence |
| job | accepted operation, input revision, execution state, result | survives requests, panes, and worker restart |

a pane references a document; it does not own the document's lifetime. two panes can share immutable content while maintaining independent positions and selections. their actual dom, canvases, layout, and selection machinery still cost memory separately.

a publication distributes stable bytes. a mutation changes authoritative state. treating both as one generic syncable object erases useful distinctions and creates avoidable protocol complexity.

monaco's documented separation between models and editors is a useful precedent; vs code's hot exit separately illustrates preservation of unsaved work. these are design lessons, not a recommendation to embed an entire code editor workbench.[^1]

**the proposed serving topology**

~~~mermaid
flowchart TD
  shell[static application assets] --> ui[persistent client workspace]
  local[account-scoped local publications and pending work] <--> ui
  ui --> api[same-origin application api and session boundary]
  api --> db[postgres: metadata, authored work, revisions, jobs]
  api --> delivery[authorized bounded artifact delivery]
  delivery --> objects[private object storage: published reading units]
  db --> workers[isolated worker processes]
  workers --> objects
  workers --> db
~~~

the boxes describe responsibilities. artifact delivery need not become another deployed service. the initial implementation can authenticate in the application api and stream object bytes through a bounded buffer. static assets can be served by the existing reverse proxy or static hosting. this avoids constructing complete document object graphs during ordinary reading.

for a clean sheet, i would choose typescript/react with a conventional vite client build, a python application api, postgres, private object storage, and the existing distinction between foreground api work and background execution. keep one backend codebase with narrow entrypoints and import-safe contracts. use managed identity; do not write an identity provider.

vite is a fit for emitting assets consumed by a separate backend.[^2] the preference is architectural judgment, not a claim that next cannot support a persistent application: next documents spa construction explicitly.[^3] public share pages can retain a small server-rendered surface where metadata previews or indexing require it.

the api would own the same-origin session boundary as well as product commands and queries. removing the separate next bff means deliberately relocating cookie, refresh, csrf, callback, native handoff, and response-security responsibilities. it does not mean exposing provider credentials to browser code. a static frontend build cannot simply retain request-time server actions or cookie handling; those features need a server owner.[^4]

the cost is explicit client loading, routing, update compatibility, and local persistence. the benefit is one fewer application-server hop and fewer independently deployed responsibilities. actual hosting savings remain unmeasured. static serving also does not make an uncached private document available during an api outage.

**publish imported documents once**

at ingestion or source replacement, produce one immutable, revisioned reading publication:

- a bounded descriptor and an addressable structure index;
- bounded text units, with html and canonical text represented where each is needed;
- declared images, styles, fonts, and other permitted assets;
- stable mappings between reading order, content units, and semantic locations;
- byte sizes, hashes, and supported schema versions.

the descriptor must not grow into another unbounded whole-library or whole-book aggregate. exceptionally large structure indexes also need addressable pages.

readium's publication manifest already separates metadata, reading order, and linked resources. its locator model supports locations across different media. borrow those concepts; immutable revision binding and explicit work budgets are additional nexus contracts, not guarantees supplied by the manifest specification.[^5]

write and verify the artifact objects first. then publish their reference and generation atomically through the database owner. the descriptor identifies the selected publication, and every subsequent unit and asset read must bind to that identity. atomic database publication alone cannot prevent a multi-request reader from mixing generations. retain the selected resources for the supported reading lifetime. unfinished objects remain unpublished and eligible for owned cleanup. preserve the source original and sufficient revision history for citations and pending user work. storage retention and cleanup are real costs.

opening an existing document should select a publication, acquire its small descriptor and needed units, and load the relevant mutable overlays. it should not reconstruct the entire publication from database rows. search text and indexes may remain in postgres as derived projections; annotations and authored notes remain authoritative records there. multiple representations are acceptable when their authority and reconstruction rules are explicit.

pdf, epub, articles, and transcripts need distinct rendering strategies. pdf keeps range-capable binary delivery and bounded page canvases. epub uses reading-order units and exact section targets. articles use semantic text units; transcripts use time-indexed cue units with an explicit generation/update contract, and currently sit outside the shared document-source union. the pdf.js team explicitly recommends limiting rendered pages and supports range loading when the server and document permit it.[^6] range loading is not a guarantee that every pdf opens after a tiny fixed download.

do not force mutable notes through a book-publication pipeline on every keystroke. they need an editor model and durable edit protocol; stable revision snapshots serve citations, export, and derived processing.

**one reader model for online and downloaded content**

nexus already has a shared document session and explicit source/progress ports. extend that seam so online and offline reading consume the same publication identities and bounded content units, supplied by remote storage or verified local storage. preserve native's sealed packages, reserved appassets host, memory-only leases, account/generation verification, and prohibition on network fallback. a shared content model does not merge transport authority.

this does not mean downloading and parsing today's complete offline zip before online reading. the existing package allows a large reader json member, and a recorded issue identifies repeated epub content for multiple navigation targets. a package can archive independently readable units; the reader opens only the units it needs.

retain an explicit update policy. opening a downloaded older revision must not silently redefine the current online publication. the proposed contract binds annotations and cursor intents to the publication on which they were made; this is not an assertion that every current annotation already carries that identity. a revision change requires an explicit transition or reviewed reanchoring outcome; it never silently rewrites coordinates. retain pending work until its conflict/removal policy permits disposal. preserve the current declared text-only article download profile and its notice; shared publication identity does not make remote images or embeds available offline.

readium's july 2026 toolkit additions include locator-addressed decorations. they merit a bounded evaluation against nexus's existing canonical text, selection, and citation contracts. the same release notes acknowledge limitations in resolving some in-chapter epub positions. adopting the toolkit without proving anchor parity would exchange understood obligations for hidden ones.[^7]

chunk boundaries must preserve accessible reading and selection. retain ordinary document semantics within a bounded reading unit and support document-wide search against the publication, with results that load the addressed unit. aggressive paragraph virtualization complicates selection spanning units, screen-reader traversal, find, printing, and scroll restoration. content-visibility can reduce layout work while keeping content in the dom; it does not bound the downloaded data or dom residency.[^8]

the tradeoff is more requests and loading transitions in exchange for bounded server and client working sets. from scratch, i would provide document-wide application search and canonical range-copy operations across unloaded units. native browser find cannot see unmounted text; those are not equivalent behaviors. existing continuous article/transcript reading remains a migration requirement, not permission to replace it with chapter buttons. preserve focused and selected content during window transitions and prove keyboard, selection, and assistive-technology behavior. if native arbitrary whole-document selection/find is mandatory, use a finite supported whole-document residency envelope or revisit the product requirement explicitly. choose unit limits through representative content and accessibility proof, not an attractive round number.

**make navigation proportional to visible work**

restoring a workspace should first restore its compact pane and visit state. load the active mobile pane or the actually displayed desktop panes with bounded concurrency. actual viewport intersection is distinct from the workspace's logical visibility flag. pin focused controls, active selections, dragging, and unfinished interactions against eviction. other offscreen panes keep restorable state; they do not all need live bodies, requests, observers, and subscriptions.

an application-owned resource store should deduplicate live immutable reads by account, resource, publication revision, and unit. the current hosted reader-source contract lacks an exposed publication revision; a revision-bound descriptor/unit contract must precede this cache. it should account for pending work until completion, including adopted prefetches. this is a refinement of existing resource-cache ownership, not justification for a universal event bus.

prefetch uses spare capacity after active work. warming a javascript chunk and fetching private document data are separate costs. desktop simultaneous panes remain supported; the limit is on expensive resident work, not on how many useful references a person may keep open.

keep read caching, desired cursor state, and immutable activity events distinct. their invalidation, coalescing, and acknowledgment rules differ. pane-local scroll and selection must not become shared just because the document bytes are shared.

linear's august 2026 architecture account offers two relevant lessons: local navigation can avoid a network round trip, and compact metadata can be filtered before large payloads are loaded. its separate serving index and change-data-capture system address an enormous sync workload. the lesson here is proportional work, not an invitation to duplicate its infrastructure.[^9]

the tradeoff is that an evicted renderer must reconstruct from its saved view state. a small measured warm-view allowance may improve switching. keeping every renderer alive increases browser residency, although it can reduce repeated server reads; it does not transfer the proven api kill mechanism.

**preserve intent independently of the view**

locally acknowledged work must be persisted before the interface claims it is retained. server acknowledgment is a separate fact. failure of a pane or network request must not destroy the durable record. a recreated coordinator reloads pending records before acknowledging more work. long-lived coordinators publish feature error state; feature renderers escalate defects inside their own boundaries. moving a throwing coordinator above the pane would recreate the workspace failure.

the minimum useful mechanisms are specific:

- reading progress stores revision-bound writer intents with stable identities; newer local movement cannot be cleared by an old acknowledgment;
- activity keeps immutable events and deletes only acknowledged records;
- note and annotation edits retain the attempted content or operation until acknowledged, with version checks protecting competing changes;
- layout remains device-local by default in the clean-sheet design, with an explicit optional restore snapshot rather than continuous arbitration of two devices' window arrangements. migration preserves the current browser-profile restore policy until that product contract is explicitly changed.

an ambiguous response requires reconciliation. a conflict cannot be resolved merely by selecting the furthest reading position or latest device clock. preserving both intentions is sometimes the correct product behavior.

the local-first paper provides a useful philosophy of responsiveness, offline capability, ownership, and longevity.[^10] the selected implementation is deliberately narrower than a full local-first database: cache chosen publications and preserve supported pending work. it does not automatically offer offline queries over the entire library or offline execution of ai services.

full workspace replication would require bootstrap, change retention, client migrations, permissions, conflict handling, and recovery to become major product subsystems. introduce that only if comprehensive offline editing and querying become explicit requirements. browser-local storage also cannot promise survival after device loss or storage clearing; confirmed server copies and recoverable backups remain necessary.

readwise documents selective offline reading and synchronization; obsidian documents concrete conflict policies. those behaviors support treating offline support and conflict resolution as product contracts. they do not establish either product's entire implementation architecture.[^11]

**keep expensive execution outside the reading path**

the api accepts bounded commands, authorizes reads, commits small transactions, and streams bounded results. parsing, extraction, indexing, and durable generation run in isolated workers. imports of metadata or wire types must not initialize every provider engine.

one user can have many concurrent jobs. preserve enforceable foreground memory, cpu, and database capacity reserves alongside measured worker concurrency; process separation alone does not reserve shared host resources. the exact number of worker processes follows peak memory, latency, and interference evidence; adding workers duplicates runtime state and may reduce available headroom.

a job owns durable input and result identities. an agent reads an identified source revision and submits a version-checked mutation or publishes a derived artifact. it uses the same authority and durability contracts as the person using the ui. its intelligence does not exempt it from stale-state checks.

postgres remains my clean-sheet default for this product's combined relational records, retrieval, and durable job state. pgvector can keep vector retrieval beside those records.[^12] this avoids introducing a separate search or queue platform merely because each feature has a fashionable dedicated product.

sqlite is credible dissent. its authors explicitly support server applications with a local database, and short writers can take turns. multiple devices behind one api do not disqualify it.[^13] for a smaller library application, it could remove operational work. here the choice must also account for vector retrieval, job coordination, notifications, and the existing concurrency model. postgres costs a service, memory, backups, and upgrades; replacing its useful mechanisms can cost more than retaining it.

a typescript api is also defensible if backend work becomes mostly simple data access. here python remains useful for document processing and execution. moving just the api to another language may divide backend ownership while retaining both ecosystems. generate and validate the wire contract from one schema owner rather than maintaining independent guesses across languages.

**private artifacts are not public assets**

immutability answers whether bytes change; it does not answer who may read them. begin with private object storage and authenticated bounded delivery. keep private responses out of shared public caches unless an explicit authorization-before-cache design is implemented and proved.

a future edge delivery route may authorize a request and serve an immutable object efficiently. that adds a service and a security-sensitive cache contract, so it is optional for a one-user workload. r2 presigned urls use its s3 api domain and cannot simply be attached to the public custom-domain cache path.[^14] a short-lived capability also carries a revocation window; previously downloaded bytes cannot be recalled from an offline device.

content sharing can reuse the publication, but permission checks and scope remain distinct. an unguessable object key is not authorization. the http caching standard treats private and authenticated responses explicitly; asset caching must preserve that boundary.[^15]

**the architectural choices and their prices**

| choice | benefit | price or limitation |
|---|---|---|
| static persistent private workspace | fewer server-rendering responsibilities; stable view ownership | client startup and compatibility become explicit; public ssr may remain |
| published immutable reading units | repeated reads reuse bytes; bounded materialization | ingest work, artifact storage, revision retention, and publication cleanup |
| bounded active views and reads | predictable working set and foreground priority | cold view reconstruction and less speculative speed |
| narrow durable local intent | work survives renderer and transport failure | storage errors, replay, reconciliation, and explicit conflicts |
| one postgres authority | relational, vector, and durable-job mechanisms together | database operation and memory budget |
| private streaming asset route first | small topology with current authorization | uncached remote reads still depend on the api |
| isolated, budgeted existing workers | enforceable limits preserve foreground resource reserves | process baseline and scheduling headroom |
| retain current framework during repair | preserves tested auth, routing, and native integration | some topology complexity remains until it earns a separate migration |

a server-rendered monolith is simpler for forms and request-oriented administration. a full replica is stronger for comprehensive offline collaboration. nexus's persistent multipane reading and editing fits the middle architecture. this is a workload judgment, not a universal ranking of frameworks.

**the migration that earns its keep**

first repair the confirmed production incident: measure and bound api residency, classify gateway unavailability correctly, contain feature failure, and preserve pending user work. a new architecture document is not incident mitigation.

then implement one reader slice through the existing publication and source boundaries. demonstrate complete traversal and stable locators while online and offline sources provide the same revisioned units. preserve existing packages and pending progress until a supported migration or explicit replacement has completed.

next align bootstrap, resource adoption, prefetch, and renderer residency with the measured budget. preserve the existing lightweight pane model and persistent shell. do not rebuild them to rename the architecture.

only then assess removing the next server/bff responsibility. require a concrete reduction in deployed processes, duplicated routing/data ownership, and operational work. account for auth, sharing, native handoffs, strict content-security policy, and long-lived client compatibility. a rewrite that merely changes syntax fails this test.

proof runs through the repository's test controller. the decisive scenarios are a large supported document, two independently positioned panes, a twelve-pane restore on mobile and desktop, worker load during reading, an api restart during a pending edit, a lost acknowledgment, a competing device edit, and a publication replacement. acceptance requires bounded server and browser residency, complete accessible reading, preserved work, strict malformed-response handling, and no unauthorized cache disclosure. allocation budgets and measured savings are still to be established.

**what the current implementation should change**

the implementation review distinguishes work in the killed python api from
browser work. these source findings do not apportion the measured memory spike.

| current behavior | architectural correction | evidence and scope |
|---|---|---|
| provider metadata imports every vendor execution sdk | make contracts and catalog imports independent of execution adapters | [startup import ticket](../tickets/second-tab-eager-provider-sdk-imports.md); api residency, savings unmeasured |
| hosted web reading obtains the complete fragment response before choosing its initial fragment | serve a descriptor and addressed, revision-bound units | [whole-content ticket](../tickets/second-tab-reader-content-response-budget.md); api and browser work |
| map and history reads materialize more than their initial presentation requires | select compact summaries and bounded details before constructing response models | [map ticket](../tickets/second-tab-document-map-response-budget.md), [history ticket](../tickets/second-tab-nexus-history-read-budget.md); api work |
| the resource cache hands off each seed once; later pane instances own independent reads | share immutable document-unit reads and retained data under their account/publication identity | [revision prerequisite](../tickets/reader-source-lacks-publication-revision.md); do not impose immutable semantics on mutable collection, annotation, or cursor queries |
| restore loads every logically visible pane, including offscreen mobile panes | restore compact references first and admit actually needed bodies | [bootstrap ticket](../tickets/second-tab-bootstrap-read-fanout.md); browser-generated api demand |
| prefetch adoption removes pending work from cache accounting | preserve operation ownership until settlement and give deliberate reads priority | [admission ticket](../tickets/second-tab-speculative-read-admission.md); a cache-entry ceiling is not an execution budget |
| offline downloads rebuild and verify unchanged publication archives in api threads | prepare once in existing workers and reuse verified artifact bytes | [package preparation ticket](../tickets/offline-download-rebuilds-publication-in-api.md); the existing outer zip delivery is streamed and preparation concurrency already bounded |
| offline descriptor and section reads depend on a fully decoded reader member | archive addressable units and open only the selected working set | [offline decoding ticket](../tickets/offline-reader-decodes-whole-publication.md); browser/webview residency |

several smaller defects deserve direct repairs, not another architecture:
an [older prefetch can settle a replacement](../tickets/second-tab-prefetch-settlement-identity.md);
[offline web navigation repeatedly scans and expands text](../tickets/offline-reader-navigation-repeated-text-allocation.md);
and [pdf streaming undermines the requested demand-fetch policy](../tickets/reader-pdf-streaming-defeats-on-demand-fetch.md).
the latter two concern browser/webview resources, not the confirmed api kill.
pdf.js explicitly documents the interaction between its streaming and autofetch
options.[^16]

preserve the counterevidence. the bff forwards the upstream response stream;
the authenticated shell already persists across pane navigation. hosted epub
already reads one section, pdf already uses signed binary delivery, and the
reader session reuses its initial section/grant. current web pane seeding does
not redundantly fetch the same fragments before the reader session. “shared
reader” currently means a common implementation and source contract; each pane
still owns its session. extend the existing seams where ownership is missing.

**repository grounding**

the assessment used the current reader contracts in [reader implementation](../modules/reader-implementation.md), [reader rationale](../modules/reader-design-rationale.md), [workspace ownership](../modules/workspace.md), and [architecture orientation](../architecture.md), checked against the actual source seams:

- hosted and local reader sources: [reader source](../../apps/web/src/lib/reader/ReaderDocumentSource.ts);
- generation publication: [publication owner](../../python/nexus/services/reader_publication.py);
- offline packaging: [package owner](../../python/nexus/services/offline_reading_packages.py);
- workspace resource loading: [bootstrap](../../apps/web/src/lib/workspace/bootstrap.server.ts);
- existing durable activity storage: [activity outbox](../../apps/web/src/lib/consumption/activityOutbox.ts).

the [incident review](second-tab-crash-council-review.md) and its individual tickets retain production evidence and unfixed defects. the current checkout and deployed artifact differ; design recommendations are not claims that current-checkout behavior is already live.

**sources**

[^1]: microsoft, [monaco editor concepts](https://github.com/microsoft/monaco-editor/blob/main/README.md) and [vs code basic editing: hot exit](https://code.visualstudio.com/docs/editing/codebasics#hot-exit), official documentation.
[^2]: vite, [backend integration](https://vite.dev/guide/backend-integration), official documentation.
[^3]: vercel, [next.js single-page applications](https://nextjs.org/docs/app/guides/single-page-applications), official documentation.
[^4]: vercel, [next.js static exports](https://nextjs.org/docs/app/guides/static-exports), official documentation, unsupported request-time features.
[^5]: readium, [web publication manifest](https://readium.org/webpub-manifest/) and [locators](https://readium.org/architecture/models/locators/), specifications.
[^6]: mozilla, [pdf.js frequently asked questions](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions), official project documentation.
[^7]: readium, [july 2026: new features in the typescript toolkit](https://blog.readium.org/release-note-readium-typescript-toolkit-july-2026/), release account.
[^8]: chrome/web.dev, [content-visibility](https://web.dev/articles/content-visibility), updated september 2025.
[^9]: peter travers, linear, [rebuilding linear's delta sync read path](https://linear.app/now/rebuilding-delta-sync-read-path), august 18, 2026.
[^10]: martin kleppmann, adam wiggins, peter van hardenberg, and mark mcgranaghan, [local-first software: you own your data, in spite of the cloud](https://www.inkandswitch.com/essay/local-first/), 2019.
[^11]: readwise, [reader frequently asked questions](https://docs.readwise.io/reader/docs/faqs); obsidian, [sync troubleshooting and conflicts](https://obsidian.md/help/sync/troubleshoot), product documentation.
[^12]: pgvector maintainers, [pgvector](https://github.com/pgvector/pgvector), project documentation.
[^13]: sqlite authors, [appropriate uses for sqlite](https://www.sqlite.org/whentouse.html), official documentation.
[^14]: cloudflare, [r2 presigned urls](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) and [r2 cache integration](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/), official documentation.
[^15]: ietf, [rfc 9111: http caching](https://www.rfc-editor.org/rfc/rfc9111.html), june 2022.
[^16]: mozilla, [pdf.js document initialization parameters](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html), official api documentation, streaming and autofetch options.
