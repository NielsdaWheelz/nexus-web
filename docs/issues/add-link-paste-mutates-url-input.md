# terminal url punctuation is a parser fidelity trade-off

the shared `apps/web/src/lib/extractLinks.ts:48–57` removes trailing punctuation. a legal address such as `https://example.test/?q=why?` becomes `https://example.test/?q=why`; the removed character also disappears from `rest`. root, import and share can therefore send a different address.

the import specification explicitly requires trailing-punctuation trimming. the old add editor is gone, but that requirement does not settle this recorded fidelity concern. this is a contract trade-off, not authorization to change the parser.

resolve when the owner chooses and records the parser rule, then actual root, import and share inputs qualify its treatment of prose and legal terminal query/fragment punctuation. ordinary parser passes do not resolve this boundary.
