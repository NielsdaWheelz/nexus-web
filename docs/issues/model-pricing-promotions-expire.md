# model pricing promotions expire

the provider runtime's 2026-10-28 snapshot uses gemini introductory rates.
argon changes after 2026-11-30 from input/output/cache usd per million
2/10/0.10 to 4/20/0.20. flash 3.8 changes after 2026-12-31 from
0.75/3.75/0.075 to 1.5/7.5/0.15. estimates are explicitly dated and indicative;
the library does not fetch prices at runtime.

source: [google pricing](https://ai.google.dev/gemini-api/docs/pricing).
owner: llm-calling `src/provider_runtime/prices_snapshot.json`. refresh the
snapshot and nexus pin when the rates change; resolved when current estimates
use the then-effective published rates. no price scheduler is required.
