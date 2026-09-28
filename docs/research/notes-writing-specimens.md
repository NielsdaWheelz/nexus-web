# writing specimens for pr 1

status: task-owned design acceptance, 2026-09-25. inspect in the authenticated app on mac desktop and physical android webview; these are content examples, not fixture infrastructure.

| specimen | text and state | visual and interaction bar |
| --- | --- | --- |
| short | “the train leaves at six.” caret before “six”; then select “train” | first tap lands at the intended word. body text is primary; selection controls appear without moving it or covering the caret |
| wrapped | “the claim sounds certain, but its evidence is thin. read the field notes before deciding what follows.” at a narrow pane width | lines wrap cleanly; selecting across a wrap keeps native handles and visible selection; no horizontal scroll or permanent action gutter |
| long | eight paragraphs of ordinary prose pasted into one note as hard breaks, with one existing image and one note reference | paste preserves every word and supported atom; unsupported typefaces/colors disappear; editing near the end does not jump focus or scroll |
| marked | “quiet evidence, strong conclusion.” mark “quiet” bold, “evidence” italic and underlined, “strong” struck, “conclusion” inline code; link “field notes” to https://example.org/notes | toolbar and keys give the same marks; pressed state has a shape cue as well as color; link text stays readable and the destination is inspectable |
| annotation | quoted source “the evidence is thin”; body “check the original measurement.” then clear and retype | quote stays read-only context; one body, no compulsory title or enter-to-save hint; mac popup and android sheet use the same commands |

labels: “bold”, “italic”, “underline”, “strikethrough”, “inline code”, “link”, and “add link” are spoken plainly. failure copy distinguishes retained local work, server acknowledgement, and conflict; no success text claims cloud durability before acknowledgement. inspect light and dark themes. acceptance needs observed screenshots/interaction notes, not taste alone.
