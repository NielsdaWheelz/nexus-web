# api metadata imports eagerly load every provider sdk

- status: open
- origin: 2026-09-13 second-tab memory investigation
- area: api startup residency / provider-runtime package boundary

## evidence

deployed nexus revision `7e8fd48244b3b436965037738e05785bb4931be1`:
`python/nexus/app.py:80` imports the profile module, whose
`python/nexus/services/llm_profiles.py:15` imports the provider-runtime facade.
the lock pins llm-calling to `6ccf36d82eb32099c305e4481cbe4cb7d39b888f`.
at that exact upstream revision:

- `src/provider_runtime/__init__.py:13` imports the runtime;
- `src/provider_runtime/runtime.py:35-38` imports every provider engine;
- `src/provider_runtime/engines/anthropic_messages.py:52` imports anthropic;
- `src/provider_runtime/engines/gemini_generate.py:64-66` imports google-genai
  and its schema types;
- `src/provider_runtime/engines/openai_chat.py:43` and
  `openai_responses.py:45` import openai.

this makes metadata/contracts load all three vendor sdk graphs before any
generation. importing a package submodule still executes its package initializer;
changing consumer imports to `provider_runtime.types` alone cannot remove it.
the current nexus lock's upstream revision
`8fde23ac56571a63c65cfcff55c73a0976f83eb4` retains the coupling at initializer
`:14` and runtime `:37-40`.

this is verified source coupling, not allocation measurement or evidence that
these modules dominate the observed memory. no profiling ran in production.

## prerequisites and fix

profile the exact deployed image's cold import, startup, and warmed request
residency in isolation; attribute module/schema and native allocations before
setting a savings target. repair the upstream package boundary so metadata and
contracts import without executing provider engines. keep generation execution
with its existing worker owners and remove worker-only imports from api command
and read paths. request features that actually call a provider must load only
their required adapter and retain an explicit request resource budget.

merely delaying the same imports until the first http request moves the cost
into request latency and leaves the warmed working set unchanged.

## acceptance

through `./scripts/test`, prove that contract/catalog imports and api startup do
not import unrelated provider engines; preserve supported provider behavior at
its execution boundary. compare cold, warmed, and peak resident memory using the
same image/dependency revisions and workload, with native allocation evidence.
show that a first request does not restore the removed baseline through another
import path. retain exact source and measurement receipts.
