# Software Development Documentation Hierarchy

> each layer constrains the layer below it, narrowing the solution space until implementation becomes unambiguous.

```
L0: CONSTITUTION (rarely changes)
    |
L1: SLICE ROADMAP (order of work)
    |
L2: SLICE SPECS (contracts per feature)
    |
L3: PR SPECS (exact work units)
    |
L4: CODE (the actual implementation)
```

## Documents

| Doc | What | Who | When |
|-----|------|-----|------|
| [Philosophy](./00-philosophy.md) | Why layered docs. The funnel model. | Everyone | Onboarding, project inception |
| [L0: Constitution](./01-constitution-L0.md) | System-wide constraints that rarely change | Architect / CTO | Project inception |
| [L1: Roadmap](./02-roadmap-L1.md) | Slice ordering, dependencies, sequencing | Product + Tech Lead | Planning cycles |
| [L2: Slice Spec](./03-slice-spec-L2.md) | Feature contracts: schemas, APIs, state machines | Spec Writer / Senior Eng | Starting a slice |
| [L3: PR Spec](./04-pr-spec-L3.md) | Scoping a single PR with exact deliverables | Implementer | Before writing code |
| [LLM Context Engineering](./05-llm-context-engineering.md) | Constructing prompts from specs for AI | Anyone using AI | Prompting AI to implement |
| [Workflow](./06-workflow.md) | Spec-first discipline, doc lifecycle, references | Everyone | Ongoing |
| [Quick Reference](./07-quick-reference.md) | Summary tables, decision tests, blast radius | Everyone | Quick lookup |

## Examples

Complete worked example across all four layers: [Bookmark Manager](./examples/bookmark-manager/)

- [Constitution (L0)](./examples/bookmark-manager/constitution.md)
- [Roadmap (L1)](./examples/bookmark-manager/roadmap.md)
- [Slice Spec (L2)](./examples/bookmark-manager/slice-2-bookmark-crud.md)
- [PR Spec (L3)](./examples/bookmark-manager/pr-01-bookmark-model.md)

## Which doc do I need?

- Making a system-wide decision? → [L0](./01-constitution-L0.md)
- Deciding what to build next? → [L1](./02-roadmap-L1.md)
- Specifying a feature for multiple PRs? → [L2](./03-slice-spec-L2.md)
- About to write code or hand off to AI? → [L3](./04-pr-spec-L3.md)
- Constructing a prompt for an LLM? → [LLM Context](./05-llm-context-engineering.md)
- Unsure about the overall process? → [Workflow](./06-workflow.md)

## Agent / Skill Mapping

| Role | Primary Context | Responsibility |
|------|----------------|----------------|
| Architect (CTO/Staff) | `00-philosophy` + `01-constitution-L0` + `02-roadmap-L1` | System design, constitution, slice ordering |
| Spec Writer (L2) | `03-slice-spec-L2` + constitution summary | Schemas, APIs, state machines, error codes |
| Implementer (L3) | `04-pr-spec-L3` + `05-llm-context-engineering` + slice spec | PR specs, code generation |
| Reviewer | `07-quick-reference` + relevant layer doc | Validate work against specs |
