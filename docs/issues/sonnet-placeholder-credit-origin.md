# sonnet imports retain a placeholder author credit

problem: saved sonnets 73, 116 and 130 carry the literal credited name “author”.
their failed metadata research explains why correction did not run, but does
not establish how those initial credits were extracted.

evidence: the 2026-11-04 read-only production inspection at `e505409d1` found
those author-role credits on media `01a18f8a-1f69-7115-8bcd-03f6ac9291ba`,
`01a17ed4-1542-7fc4-a895-970361204d30` and
`01a17ed4-52f1-73fa-80d0-82966d507b60`. at checkout `b115cbce7`,
`python/nexus/services/web_article.py:433-448` accepts nonempty extracted
bylines as author observations. this is a possible path, not established
provenance for those exact imports.

inspect each saved capture's original markup and extraction facts before
changing parsing. a demonstrated extraction error belongs to its source adapter;
do not blacklist “author” globally, infer identity from a title-specific rule,
or rename the shared placeholder contributor to shakespeare.

resolved when the origin is explained and any demonstrated adapter defect is
fixed, then ordinary correction attaches the actual evidenced person to these
works. distinguish contributor identity from its displayed credited spelling.
search restoration is tracked in [the dependency issue](brave-search-payment-required.md).
