# 0003 — The AI assistant's place in the product

**Status:** **Option 1 accepted, 2026-08-09.** x-studio is an AI-native dashboard builder. AG Studio
parity is a baseline, not the goal.

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

**Option 1. x-studio is an AI-native dashboard builder.** AI is the differentiator; AG Studio parity
is a baseline to clear, not the target to hit.

The codebase was already this product. What was missing was the sentence saying so, and the effect
of its absence was that the largest subsystem in the tree read as scope creep against a document
nobody had updated.

**The AG Studio comparison was a first pass, and is dated.** That reframes two documents rather than
retiring them. `AG_STUDIO_CLONE_REQUIREMENTS.md` was written to answer "what would it take to build
this category of thing at all", and it answered it well — but it is a competitor teardown from
before the direction was set, so its MVP boundary is not the release criteria. Same for
`AG_STUDIO_GAP_ANALYSIS.md`: a parity checklist is a useful baseline check and a poor roadmap,
because the things it cannot see are exactly the things this product is now differentiating on. A
feature absent from AG Studio does not appear in a gap analysis against AG Studio as an opportunity;
it does not appear at all.

Both are now labelled as historical baselines rather than current scope, and §2.2 / §9 of the
requirements are corrected in place rather than left contradicted — a reader who finds "MVP
excludes: AI assistant" and no correction has no way to know which document to believe.

## Consequences

**ADR 0004 (the semantic model) becomes urgent rather than medium.** This is the substantive
consequence, and it follows directly from the choice. A governed semantic layer is the
anti-hallucination substrate the team's own research identifies — `AI_ASSISTANT_RESEARCH.md`:
_"Everyone is racing to own the semantic/business logic layer as the anti-hallucination foundation.
AI agents that query raw SQL hallucinate; those grounded in a governed semantic layer don't."_ Under
option 2 the current dashboard-embedded model would have been an unchosen default worth tidying
eventually. Under option 1 it is a strategic gap, and 0004's own warning applies with full force:
cheap while dashboards are unpublished, a data migration across every stored document afterwards.

**ADR 0002 (tiering) does not become moot, but its shape changes.** "The AI subsystem is the paid
tier because it is the differentiated part" was the obvious answer under option 2. It is a harder
question here: if AI is the product rather than a feature of it, a tiering seam that puts AI
entirely behind the commercial line also puts the product's identity there, and the MIT package
becomes the thing the product is explicitly not. Still open, and still the one whose delay compounds.

**ADR 0005 is unaffected.** The execution contract is equally load-bearing either way — more so
under this decision, since an AI that authors queries needs one definition of what a query means.

Corresponds to finding A3 of [`SYSTEM_ARCHITECTURE_REVIEW.md`](../SYSTEM_ARCHITECTURE_REVIEW.md).
