# downloaded reader title overlaps its return label

problem: a long title overlaps the shelf header's `downloads` label on a phone,
making both harder to read. this is separate from contents-panel scrolling.

evidence: source `26507b6e7`, native lab `20261028-201503-b4d99d9ffe6a`,
android 15 with chromium webview `159.0.8130.0`. the retained
`artifacts/native-downloaded-contents.png` shows the title crossing the label.
`apps/web/src/shelf/Shelf.tsx:47–50` places the button and title in one flex row;
`shelf.module.css:57–75` defines their layout. the companion change does not
alter that header.

keep the return control's intrinsic width and let the title yield at the shelf
layout owner. resolved when long titles truncate without overlapping the fully
visible, reachable return control at phone widths and enlarged text.
