# CodeIntent Studio — AO Client Demo Script

Representative dataset: "First National" core deposit platform, COBOL → Java Spring Boot.
Total runtime ~15 minutes.

> **Studio v1 is a read-only evidence surface** — the language below is calibrated to that; do not improvise stronger claims.

## Pre-flight (before the client joins)

Run `npm run studio`, open <http://127.0.0.1:8787/studio>, click **Ask CodeIntent**, and confirm the status strip reads:

```text
MCP bridge: connected · CodeIntent 2026.06.r1 · read-only
```

If it doesn't, restart the bridge **before** the meeting, not during it.

## 1. Frame — 1 min

**Say:**

> "Everyone can generate code now. The hard problem is accepting it. 'It passes all the unit tests' is not an acceptance standard for a regulated deposit system — unit tests only check what someone thought to test. Code generation is becoming free. Code acceptance is becoming priceless. What you're about to see is the acceptance side: a deterministic, source-traceable evidence baseline recovered from the legacy codebase itself. Everything on screen is representative demo data."

## 2. Delivery Overview — 2 min

**Do:** land on Delivery Overview; walk the top strip, then the semantic map.

**Say:**

> "2.1 million lines of COBOL — 1,323 programs, 318 copybooks — decomposed into intent units and bound to the generated Java at symbol level. 100% of source artifacts accounted for: 1,292 dispositioned, 31 excluded, zero unexplained. Every unit lands in one of six disposition states — Verified, Preserved, Allowed Change, Net-New, Review Boundary, Orphaned. Nothing is silently absorbed: 98.6% of generated code traces to source, and the 1.4% that doesn't is named scaffolding with an owner."

**Do:** click a map region to filter into the Scope Ledger.

## 3. Scope Ledger — 2 min

**Do:** pivot "By business intent."

**Say:**

> "This is the working ledger: source artifact → intent unit → target artifact, with disposition and the evidence record behind every row. Your reviewers don't audit two million lines — they audit dispositions and challenge evidence."

## 4. Trace Explorer — 3 min

**Do:** open the pinned trace **Dormant Account Accrual Suppression** and walk the binding chain left to right.

**Say:**

> "One rule, end to end. Source: `ACCT-INTEREST.CBL`. CodeIntent recovered the rule — R-CTRL-006, dormant accounts don't accrue interest — directly from the code, not from documentation or tribal memory. Target: `InterestAccrualService.java`, with a deterministic equivalence record, EQV-2272. Same input, same result, every run — checkable evidence, not a model's opinion."

**Optional:** run the live CSUTLDTC equivalence check, noting the on-screen caveat that it's a browser build of the verification engine, not a mainframe run.

## 5. Ask CodeIntent (MCP) — 3 min

**Do:** open Ask CodeIntent; point to the status strip.

**Ask:**

```text
Why don't dormant accounts accrue interest?
```

The answer comes back citing R-CTRL-006 and its evidence.

Then the key moment — **ask:**

```text
What happens if I remove the dormant status guard?
```

**Say:**

> "That's `check_change`, one of five read-only MCP tools. Verdict: **NOT BEHAVIOR-PRESERVING — route to change governance.** It's an advisory evidence check — it doesn't modify or block anything; it determines what evidence a change requires and fails explicitly when a verified behavior would be altered. Any coding agent — Claude Code, Copilot — queries this same baseline over MCP. LLMs propose. Holonic verifies."

## 6. Verification & Governed Boundaries — 2 min

**Say:**

> "Evidence categories stay separate so nothing hides inside an aggregate: deterministic equivalence records, structural preservation — 48 branch, 24 data-mapping — contract conformance, and 312 generated test artifacts, exportable for execution by AO or the customer's own harness. Then the four governed boundaries: everything the delivery could not silently absorb is surfaced, typed, owned, and dispositioned — zero open at baseline."

## 7. Close — 1 min

**Do:** click **Export evidence package**.

**Say:**

> "The baseline is client-controlled and export-ready, and it persists after delivery — this is the control layer for legacy modernization, and it keeps governing change after cutover. The natural next step is a scoped assessment on one of your codebases, so you're looking at your own numbers instead of First National's."
