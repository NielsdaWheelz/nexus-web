# independent reader theme can disagree with surrounding highlight inks

problem: reader highlights use the reader’s independent theme; picker swatches,
map ticks and adjacent excerpts inherit the surrounding room. choosing a dark
reader in a light room, or the reverse, can therefore produce different inks.

impact: a swatch or margin passage need not match the mark on the page.
`lib/documentReader/documentReader.module.css` owns reader literals;
`app/globals.css` owns room tokens. librarian figures now use the correct inks
for their room; the remaining mismatch concerns independent reader themes.

fix: apply matching reader-theme tokens to reader-owned adjacent surfaces.
retain required literal `::highlight` colours where browser support requires them;
do not change librarian’s room inheritance.

resolved when picker swatches, map ticks and excerpts match page highlights in
both mismatched reader/room combinations. verify all highlight colours.
