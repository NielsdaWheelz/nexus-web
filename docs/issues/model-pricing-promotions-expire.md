# gemini carbon introductory pricing expires

the november 20 provider snapshot uses carbon's introductory input, output and
cached-input prices of $2, $10 and $0.10 per million tokens. on december 1,
2026 these rise to $4, $20 and $0.20. the snapshot feeds indicative estimates.

refresh `llm-calling/src/provider_runtime/prices_snapshot.json` and adopt the
new dependency pin when the rates change. verify an estimate with uncached
input, cached input and output against the effective prices. [google pricing](https://aistudio.google.com/docs/pricing#gemini-4-carbon)
