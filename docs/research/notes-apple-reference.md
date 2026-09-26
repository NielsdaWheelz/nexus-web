# apple notes: writing reference

status: research; proposed acceptance, not an implementation specification
date: 2026-09-25
scope: writing and saving in notes, annotations, link notes, and quick capture
evidence: public documentation and user reports; no device observation

the latest brief excludes product navigation, offline support, and the full
feature catalogue. this reference therefore covers the writing surface and
its saving contract. preserving pending work through an interruption belongs
to saving; an offline application, local library, and sync engine do not.

## judgment

copy the continuity of writing. a thought should not require a title decision,
an edit-mode negotiation, or a save ceremony before it becomes durable work.
the difficult part is preserving that continuity through selection, input
methods, formatting, interruptions, and errors. quieter buttons cannot repair
a caret that moves or a save acknowledgement that overstates its guarantee.

apple supplies the prose interaction reference; roam supplies the intentional
structural deviation. one editing session must own document, selection and
history. neither a toolbar nor a bullet handler should maintain another copy
of that state. this is an architectural recommendation, not a claim about
apple's proprietary implementation.

## eight documented facts

1. mac notes saves during editing; its first line supplies the title. normal
   paste may normalize font and color, while match-style and retain-style
   paste are distinct commands. copying every clipboard style is therefore
   not required to reproduce ordinary apple paste behavior.
   [mac 26 writing guide](https://support.apple.com/guide/notes/create-and-edit-notes-not9474646a9/4.13/mac/26)
2. the iphone creation flow is compose, type, done; the first line supplies
   the title. its guide documents rich formatting and collapsible headings.
   the wording describes done as saving, but specifies neither a durable
   commit point nor what happens when the app is killed immediately.
   [iphone 26 writing guide](https://support.apple.com/guide/iphone/create-and-format-notes-iph1ac0b3a2/26/ios/26)
3. mac formatting includes inline emphasis, underline, strikethrough,
   highlights, paragraph styles, alignment, and font controls. headings can
   collapse their sections. the existence of these features does not settle
   which belong in nexus's everyday-formatting whitelist.
   [mac 26 formatting guide](https://support.apple.com/guide/notes/format-notes-apd1955d3b21/4.13/mac/26)
4. apple documents word selection by double tap, paragraph selection by triple
   tap, selection handles, insertion-point magnification, keyboard-trackpad
   positioning, and text dragging. its current page is versioned for ios 27;
   these are a reference checklist, not verified behavior on the user's device.
   [iphone text editing](https://support.apple.com/guide/iphone/select-edit-and-move-text-iph1a9cae52c/27/ios/27)
5. mac notes has separate text and application commands. return enters the
   selected note from its list; within a list, shift-return is a soft break
   and tab changes nesting. context determines meaning. keyboard layouts can
   change available bindings. nexus must similarly scope structural shortcuts.
   [mac 26 shortcuts](https://support.apple.com/guide/notes/keyboard-shortcuts-and-gestures-apd46c25187e/4.13/mac/26)
6. iphone notes participates in dynamic type. mac notes exposes default text
   size and per-note zoom. a fixed screenshot at one text size is insufficient
   evidence of visual or interaction fidelity.
   [iphone text size](https://support.apple.com/en-au/102453),
   [mac 26 viewing controls](https://support.apple.com/guide/notes/view-your-notes-apd8b73d28be/4.13/mac/26)
7. icloud.com's editor saves automatically but cannot attach items itself;
   apple directs attachment creation to native apps. apple's own browser
   offering is therefore not a full native-parity specification.
   [icloud web writing](https://support.apple.com/en-in/guide/icloud/mmc0cd6edf/icloud)
8. apple's standard native text views supply system selection affordances;
   custom native text views can adopt them through the text-input interfaces.
   this establishes the value of platform integration. it does not establish
   which private editor classes notes uses, or grant equivalent native control
   to a browser implementation.
   [system selection integration](https://developer.apple.com/documentation/uikit/adopting-system-selection-ui-in-custom-text-views)

the version-pinned mac and iphone 26 pages are documentary baselines. live
support pages also advertised version 27 during this research. that is not
proof of release status or of the user's installed version. pin actual os,
browser, input method, scale and app version before recording reference clips.

## platform behavior matrix

these are proposed nexus requirements derived from the references above.
the apple baseline and unverified edge cases must remain distinguishable.

| concern | iphone writing target | mac writing target | ownership / unresolved edge |
| --- | --- | --- | --- |
| activation | a tap in text puts the caret at the intended location and opens input without a second edit action | click-to-caret, hardware typing immediately available | shared editor; empty-space tap position needs observation |
| selection | platform handles, magnifier, word/paragraph selection, keyboard trackpad | native-style word/line/range selection and modifier movement | shared editor; cross-block ranges meet roam structure |
| composition | dictation, autocorrection, predictive replacement and composing keyboards retain text | composing keyboards, dead keys and spelling replacement retain text | shared editor; no structural command during an unfinished composition |
| format | a compact touch-accessible format surface preserves selection | toolbar/context actions and familiar platform keys produce the same result | shared format commands; exact supported marks remain a spec decision |
| clipboard | platform copy/paste works without an extra editor mode | normal paste and explicit plain/match-style policy | shared clipboard boundary; outline paste extends it in the roam pr |
| scrolling | caret remains above the keyboard; selection and composition survive keyboard resizing | caret stays visible without save-induced scrolling | editor/view; floating keyboard and rotation are targeted checks if supported |
| leaving | done may dismiss; successful saving does not require done | switching context or closing a writing surface does not require save | persistence owner; distinguish local retention from server acknowledgement |
| accessibility | enlarged text, voiceover and touch targets remain usable | keyboard focus, zoom and assistive text navigation remain usable | shared surface; structure needs named actions, not tiny unlabeled dots |

the mac/iphone distinction is intentional. identical chrome would discard
different input capabilities. ipad contributes useful edge cases such as a
hardware keyboard plus touch, but is not a third independently promised target
in this brief. icloud.com is a web feasibility comparison, not the reference
whose reduced feature set silently determines the product.

## visual contract

apple's published design rationale places content ahead of controls and makes
control placement predictable across platforms while retaining their distinct
density. it treats translucent navigation and controls as a separate layer.
that supports quiet writing chrome; it does not justify adding blur to every
block or making controls harder to read.
[wwdc25 design rationale](https://developer.apple.com/videos/play/wwdc2025/102/),
[liquid glass overview](https://developer.apple.com/documentation/TechnologyOverviews/liquid-glass)

proposed contract: text dominates; editing does not introduce a card around
each paragraph; caret, selection, line wrapping and scroll position stay
stable; formatting controls appear where the selected platform makes them
usable. hover can expose secondary controls on mac. touch must have an
equally discoverable path without hover. subtle bullet glyphs may have larger
invisible targets, provided adjacent targets do not conflict.

before implementation, capture a small shared specimen on both target devices:
empty editor, short prose, wrapped prose, formatted selection, nested bullets,
keyboard open, and a save failure. record light/dark and enlarged-text variants.
measure the reference's actual text family, size, weight, line height, measure,
insets, toolbar geometry, selection colors and bullet alignment. these values
were not measured here. do not invent pixel numbers or animation durations.

the first-line title convention is not automatically transferable to every
nexus surface: annotations already have quoted context, and pages already have
identity. avoid adding a mandatory title field to mimic an incidental screenshot.
decide title derivation and outline-root behavior together in the specs.

## saving: what the sources do not prove

autosave documentation describes a user interaction, not a durability protocol.
idk apple's commit interval, journal design, acknowledgement point, crash-loss
window, or conflict algorithm from these sources. no claim of those internals
belongs in a nexus spec. likewise, a browser displaying text is not evidence
that its draft was retained or its server write acknowledged.

the proposed nexus contract distinguishes visible edits, locally retained
pending work and server-acknowledged versions. preserve newer edits when an
older response arrives; keep ambiguous submitted requests immutable; preserve
recovery payloads when parsing or storage fails. ordinary leaving should be
quiet. inability to retain work should be conspicuous and actionable. this is
a product requirement for trustworthy saving, not an offline-mode proposal.

## bounded acceptance packet

all checks below are proposed; none was run against apple or nexus here.
use the same compact packet on every existing writing surface, with one
representative long note to expose size-dependent behavior.

| id | action | pass condition |
| --- | --- | --- |
| a1 | open, tap/click mid-word, type; repeat during initial hydration | first intended input arrives once at the intended caret; no second activation |
| a2 | select across wrapped text, drag a handle, replace selection, undo | correct range and stable scroll; undo restores content and selection |
| a3 | dictate, accept/reject autocorrection, enter composed text and emoji | no lost or duplicated text; structural shortcuts do not interrupt composition |
| a4 | format a range through each available input route, continue typing, undo | one defined result, preserved selection and predictable subsequent typing style |
| a5 | paste prose, rich text, a url and a multiline outline | documented normalization and supported formatting; structural meaning handled once |
| a6 | type, dismiss, switch context, background, reopen | latest successfully retained revision is recovered; failure is never reported as saved |
| a7 | lose a save response, type more, retry, deliver the old response late | no duplicate mutation, stale replacement, or deletion of successor work |
| a8 | fail local retention or server save; reopen recovery | work remains reachable; state describes the actual failure and offers a useful action |
| a9 | enlarge text, use voiceover/keyboard, open and dismiss formatting controls | usable targets, labels and focus return; text remains readable and editable |
| a10 | trace typing, caret motion and save completion on named devices | no network dependence for character feedback; no save-induced focus or scroll jump |

native gesture and keyboard acceptance needs physical-device observation.
source review cannot pass it. performance targets belong in the consolidated
spec after naming devices, document sizes and the measurement method; no apple
latency measurements were collected. repository static checks are a separate
claim under [the local verification contract](../local-rules/testing-standards.md).

## useful comparisons and expert objections

drafts opens ready for capture and deliberately distinguishes returning to an
active draft from starting another. borrow its reduction of preparatory work;
do not import its timeout behavior into an annotation tied to a specific quote.
[drafts capture behavior](https://docs.getdrafts.com/docs/editor/new-drafts-and-pinning)

bear's developers describe hiding markup so users can write without learning
markdown, and make large-document editor performance a design requirement.
borrow the legibility and performance discipline. their reported benchmark is
vendor evidence, not a measured nexus target or a reason to rebuild our editor.
[bear's editor rationale](https://blog.bear.app/2023/08/behind-the-scenes-of-the-journey-to-bear-2/)

user reports complicate the apple ideal: a 2023 community thread reports mac
typing lag in large libraries and long notes; recent notes-community discussions
ask for recoverable version history. these are anecdotal failure probes, not
prevalence estimates or proof of a current apple defect. copy the intended
fluency without turning every observed defect into a parity requirement.
[apple community lag report](https://discussions.apple.com/thread/254559867),
[september 2026 user discussion](https://www.reddit.com/r/AppleNotesGang/comments/1w9986o/is_there_a_list_of_missing_features_in_apple_notes/)

the editor expert rejects splitting touch and keyboard ownership: both can
change selection and structure in the same operation. the interaction designer
rejects copying mac density onto iphone. the reliability engineer rejects
invisible save failures in the name of minimalism. the accessibility specialist
rejects gesture-only capabilities and indiscriminate key interception. the
product designer rejects treating full feature parity as the route to a quiet
writing surface. these tensions should be settled explicitly in the two specs.

remaining decisions: the formatting/clipboard whitelist; annotation enter/done
semantics; title and outline-root treatment; version-pinned interaction samples;
and the exact vocabulary for retained versus server-saved work. these are
specification choices, not permission to grow the product catalogue.
