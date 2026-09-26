# article contents truncates headings containing a line break

status: open
origin: 2026-09-25 article-contents review, `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`
area: web article navigation

in-memory owner inspection of `prepare_web_article_fragment` with
`<h2>first<br>second</h2><p>body</p>` retains the full sanitized heading and
heading path `('first second',)`, but the published label source is only
`first`. `python/nexus/services/canonicalize.py:137–138` maps the break to a
canonical newline. `web_article_structure.py:290–318` uses the first line's
end for the heading block; `reader_navigation.py:107–109` slices that line for
the contents label. these latter paths are beneath `python/nexus/services/`.

the contents can omit the words that distinguish destinations even though the
heading identity contains the full normalized text. this affects any consumer
of the shared navigation, including the proposed article section dropdown.

prerequisite: preserve persisted canonical text and exact navigation targets.
derive navigation labels from the complete heading element's normalized text,
at the structure/navigation owner; keep line index boundaries separate. do not
repair labels in an individual widget or rewrite saved article bodies.

acceptance: the example publishes `first second` with its original exact
target; repeated, nested, and ordinary one-line headings retain their correct
labels and distinct destinations. verify through the shared contents surface.
the review observed owner output only, not a hosted reader journey.
