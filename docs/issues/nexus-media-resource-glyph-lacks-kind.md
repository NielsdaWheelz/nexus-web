# media resource glyph lacks kind

nexus resource rows use `resourceIconForScheme` in `apps/web/src/lib/nexus/rows.ts`, so media results share a generic file glyph instead of identifying their media kind. the palette content contract requires kind in the glyph.

the current base has only media labels in `lib/media/kind.ts`; main pr #888 supplies the shared kind helpers. integrate that helper after rebasing rather than creating a second icon registry. resolved when books, episodes, videos and articles render their owned kind glyphs in typed resource results, including forced-colour views.
