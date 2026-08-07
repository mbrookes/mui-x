# 0003 — The AI assistant's place in the product

**Status:** Open. Raised 2026-08-07. **Blocks the correct prioritization of 0002, 0004 and 0005.**

## Context

`AG_STUDIO_CLONE_REQUIREMENTS.md` §9, verbatim: **"MVP excludes: AI assistant."** §2.2 also lists
"AI assistant and natural-language authoring flows" as out of scope for the MVP.

What was built:

```text
x-studio-ai-middleware              10,660 lines   an entire package
StudioChatPanel/                     3,622 lines   22 files in the binding
  + the tool registry, the SSE transport, richContext, generateInsight
```

The AI assistant is the single largest coherent subsystem in the product, and the majority of the
last fifty review rounds went into it. Measured against the written scope, the largest thing built
is the thing the MVP says not to build.

**This is not automatically wrong.** The team's own `AI_ASSISTANT_RESEARCH.md` surveys the
competitive landscape and concludes AI is where this category is being decided. Choosing to
differentiate on AI rather than to clone AG Studio feature-for-feature is a legitimate — possibly
correct — strategic pivot.

**What is wrong is that the pivot is unrecorded.** The requirements document still says the MVP
excludes it. No architecture document mentions a change of direction. So the codebase and the
requirements assert different products, and there is no artifact saying which one is current.

## Options

1. **AI-native dashboard builder.** AI is the differentiator; AG Studio parity is a baseline, not
   the goal. Requires amending `AG_STUDIO_CLONE_REQUIREMENTS.md` §9 and §2.2 rather than leaving
   them contradicted.
2. **AG Studio parity, with AI as one feature.** The written scope broadly stands; the AI
   subsystem is ahead of schedule rather than off-plan. Requires an honest look at whether the
   parity gaps in `AG_STUDIO_GAP_ANALYSIS.md` are getting proportionate attention.
3. **Two products.** An MIT dashboard builder and an AI layer sold separately — which is really
   ADR 0002 option 1, arrived at from the product side rather than the commercial side.

## Decision

**Open.**

Every other open question in this log is prioritized differently depending on the answer:

- **If AI-native:** ADR 0004 (the semantic model) becomes urgent rather than medium. A governed
  semantic layer is the anti-hallucination substrate the team's own research doc identifies —
  `AI_ASSISTANT_RESEARCH.md` line 61: _"Everyone is racing to own the semantic/business logic
  layer as the anti-hallucination foundation. AI agents that query raw SQL hallucinate; those
  grounded in a governed semantic layer don't."_ Under this reading, the current
  dashboard-embedded model is not just an unchosen default, it is a strategic gap.
- **If parity-with-AI:** ADR 0002 (tiering) dominates, and the AI subsystem is the obvious paid
  tier because it is the differentiated part rather than the baseline.

An architecture cannot be assessed against an intent nobody has written down. **This costs no code
to fix.** It costs one paragraph, in a file the team already maintains.

## Consequences

**Of answering:** the other four ADRs get their real priority, and the requirements document stops
describing a product that is no longer being built.

**Of not answering:** each future reviewer re-discovers the same contradiction and re-litigates it
from scratch — which has already happened three times — and the requirements document decays into
a historical artifact that new contributors read as current.

Corresponds to finding A3 of [`SYSTEM_ARCHITECTURE_REVIEW.md`](../SYSTEM_ARCHITECTURE_REVIEW.md).
