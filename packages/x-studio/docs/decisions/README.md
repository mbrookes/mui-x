# Architecture decision records

`ARCHITECTURE.md` in each x-studio package describes **how the code works**. This directory
records **why the system is shaped the way it is** — the structural choices that no amount of
reading the code will recover, because a choice and its unchosen alternatives look identical once
only the winner is in the tree.

The log exists because of a finding in
[`SYSTEM_ARCHITECTURE_REVIEW.md`](../SYSTEM_ARCHITECTURE_REVIEW.md): every one of that review's six
findings had the same shape — a consequential structural property with no record of having been
chosen. Three review rounds could only find mechanism problems, because mechanism was all that was
written down.

## Index

| #                                              | Decision                            | Status                                                               |
| :--------------------------------------------- | :---------------------------------- | :------------------------------------------------------------------- |
| [0001](./0001-engine-binding-package-split.md) | Engine / binding package split      | **Accepted** — implemented                                           |
| [0002](./0002-commercial-tiering-seam.md)      | Commercial tiering seam             | **Open** — decision needed                                           |
| [0003](./0003-ai-assistant-product-scope.md)   | AI assistant's place in the product | **Accepted** — AI-native; parity is a baseline, not the goal         |
| [0004](./0004-semantic-model-home.md)          | Where the semantic model lives      | **Open** — decision needed, made urgent by 0003                      |
| [0005](./0005-primary-execution-path.md)       | Which execution engine is primary   | **Accepted** — the descriptor is the execution contract; implemented |
| [0006](./0006-wire-protocol-versioning.md)     | Versioning the two host wires       | **Accepted** — implemented                                           |

## Writing one

Copy the shape of 0001. Five headings, in this order:

- **Status** — `Open`, `Accepted`, `Superseded by NNNN`, or `Rejected`, with a date.
- **Context** — the forces. What is true about the system, the product, or the market that makes
  this a question at all. Measured numbers where a number is the argument.
- **Options** — every branch that was genuinely on the table, each with its real cost. An ADR
  listing one option is a press release, not a decision record.
- **Decision** — the choice, stated as a choice. `Open` is a legitimate value here: an ADR that
  frames a question honestly and says nobody has answered it is worth far more than silence, and
  it is the only artifact that stops the question being re-discovered by the next reviewer.
- **Consequences** — what this makes cheap, what it makes expensive, and what it forecloses. Be
  specific about the reversal cost, because that is the number that decides whether the decision
  can wait.

Two conventions:

- **An ADR is append-only once accepted.** Changing your mind means a new record whose Status
  supersedes the old one, not an edit — the point of the log is that a superseded decision, and
  the reason it was superseded, both stay readable.
- **Cite the measurement, not the impression.** Where a finding rests on a size, a count or a
  closure, say how it was measured so the next reader can re-run it rather than re-derive it.
  `packages/x-studio/scripts/checkReactFreeClosure.py` exists for exactly this reason.
