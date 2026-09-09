# Mino pilot-readiness roadmap

This document begins the product-readiness sequence after the provider-neutral architecture campaign (#31–#38) and durable high-risk administrative governance (#39).

The objective is deliberately narrower than a public self-service launch:

> Make one external design partner able to get from an existing agent and payment workflow to a real Mino-governed economic action safely, with concierge support, without understanding Mino's internal architecture.

## Pilot shape

The first design-partner pilot should remain intentionally bounded:

- one design partner;
- one Mino organization;
- at least two human administrators so four-eyes governance is real;
- one or two agents;
- one concrete economic workflow;
- one execution/payment provider selected by the design partner's real stack;
- sandbox/test money first;
- tightly bounded live money only after sandbox acceptance.

Mino should be operated as a hosted service for the first pilot. Requiring the first customer to self-host would prematurely turn installation, secret management, backups, topology, upgrades, and operational support into prerequisites for validating product demand.

## Product success path

The pilot-facing setup loop is:

```text
organization / administrators
        |
beneficiary
        |
agent identity
        |
policy
        |
provider / counterparty path
        |
mandate proposal
        |
distinct administrator approval
        |
explicit governed apply
        |
agent transaction
        |
ALLOW / BLOCK / transaction approval
        |
outcome / reconciliation / audit evidence
```

Every pilot-readiness PR should shorten or strengthen this path without weakening the existing authorization, audit, reconciliation, provider-neutrality, or administrative-governance boundaries.

## Status snapshot (vs `main` through #53)

| Roadmap item | Status |
| --- | --- |
| #40 Pilot-facing access baseline | Implemented (PR #40) |
| #41 Beneficiary administration | Implemented (PR #41) |
| #42 Guided first-run setup / human money UX | Implemented (PR #42) |
| #43 Agent integration kit | Implemented (PR #43) |
| #44 First design-partner execution path | Partially on `main` as Personal + Stripe (#44–#51) + consequence fence (#53); remaining = partner-specific packaging |
| #45 Pilot ops / release package | Docs in PR #54 (`docs/PILOT_OPS_PACKAGE.md`, `docs/PILOT_ACCEPTANCE_CHECKLIST.md`); hosted drills after merge |

Detail sections below preserve original scope notes. Deferred list unchanged.

## PR #40 — Pilot-facing access baseline

**Status: implemented by GitHub PR #40.**

## PR #41 — Beneficiary administration

**Status: implemented by GitHub PR #41.**

## PR #42 — Guided first-run setup and human money UX

**Status: implemented by GitHub PR #42.**

## PR #43 — Agent integration kit

**Status: implemented by GitHub PR #43.** See `docs/agent-integration-kit.md` and `src/client/mino-agent-client.ts`.

## PR #44 — First design-partner execution path

**Status: partially landed** under later GitHub numbers (Personal + Stripe #44–#51, #53). Remaining work is packaging the first named partner's provider path — not a catalog.

## PR #45 — Pilot operations and release package

**Status: docs package in GitHub PR #54.** See `docs/PILOT_OPS_PACKAGE.md` and `docs/PILOT_ACCEPTANCE_CHECKLIST.md`.

## What is deliberately deferred

Pilot readiness does not require building all future SaaS infrastructure.

Do not pull these forward without customer evidence:

- billing/subscription system;
- public anonymous signup;
- general-purpose customer-authored policy DSL;
- broad provider catalog;
- mobile application;
- elaborate analytics;
- a new identity platform;
- self-hosting as a prerequisite;
- large compliance-certification projects solely for appearance rather than a concrete pilot requirement.

## Pilot acceptance criteria

A successful first design partner should demonstrate all of the following:

1. credentials/setup to first governed sandbox transaction in under one hour with Mino assistance;
2. at least one real `ALLOW` case;
3. at least one policy `BLOCK` case;
4. at least one transaction-level human approval case;
5. soft approval cannot override a hard `BLOCK`;
6. at least one high-risk administrative four-eyes action;
7. immediate fail-closed mandate revocation;
8. reconciliation behavior for an uncertain/nonterminal provider outcome;
9. operator ability to find the resulting administrative and transaction audit evidence;
10. no design-partner code change required merely because execution-provider provenance changes while normalized economic meaning stays the same;
11. a credible answer to: "Would this team keep Mino enabled after the pilot?"

The most important commercial signal is not transaction volume. It is whether the partner treats Mino as necessary infrastructure they would otherwise have to build before trusting an autonomous agent with economic authority.
