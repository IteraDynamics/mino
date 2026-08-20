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
        ↓
beneficiary
        ↓
agent identity
        ↓
policy
        ↓
provider / counterparty path
        ↓
mandate proposal
        ↓
distinct administrator approval
        ↓
explicit governed apply
        ↓
agent transaction
        ↓
ALLOW / BLOCK / transaction approval
        ↓
outcome / reconciliation / audit evidence
```

Every pilot-readiness PR should shorten or strengthen this path without weakening the existing authorization, audit, reconciliation, provider-neutrality, or administrative-governance boundaries.

## PR #40 — Pilot-facing access baseline

**Status: implemented by GitHub PR #40.**

Implemented scope:

- enrolled organization name and administrator display metadata are exposed after authorization while stable IDs remain primary technical identity;
- presentation metadata does not enter authorization decisions or mutation actor contexts;
- the console is human-first without removing audit/support identifiers;
- post-#39 four-eyes documentation is normalized;
- the concierge pilot boundary is explicit.

## PR #41 — Beneficiary administration

**Status: implemented by GitHub PR #41.**

Implemented scope:

- organization-scoped beneficiary inventory/detail;
- explicit `beneficiary.read`, `beneficiary.create`, and `beneficiary.suspend` permissions;
- normalized organization-local creation using the existing `User` model;
- equivalent active creation replay without duplicate administrative audit history;
- atomic suspension plus signed administrative audit;
- immediate fail-closed mandate invalidation when the beneficiary becomes inactive;
- active human-readable beneficiary selection during mandate proposal;
- exact tenant scoping and inactive/terminal conflict behavior;
- preservation of the distinction between spending-beneficiary `User` and administrative `AdminPrincipal`.

The lifecycle surface remains deliberately one-way for the pilot: suspension is supported, but reactivation is not. Reactivation could restore still-valid historical mandates and therefore requires an explicit future authority-restoration design.

## PR #42 — Guided first-run setup and human money UX

**Status: implemented by GitHub PR #42.**

Implemented scope:

- an Overview checklist for beneficiary → keyed agent → active policy → active execution route → governed mandate;
- readiness derived only from existing permission-checked administrative reads;
- direct next actions into the existing governed console surfaces;
- human-readable beneficiary/agent/policy selectors during mandate proposal;
- policy monetary entry in major currency units while preserving existing exact backend minor-unit fields;
- decimal-string plus integer/`BigInt` conversion rather than floating-point money arithmetic;
- explicit USD/EUR/GBP, JPY, BHD, and KWD decimal precision handling;
- no automatic FX conversion when currency changes;
- clear copy distinguishing policy creation, four-eyes activation, mandate proposal, approval, and apply;
- bounded first-100 inventory inspection with an explicit truncation warning rather than pretending the checklist is an authoritative inventory service.

Non-goals preserved:

- no new backend permission or mutation authority;
- no new database schema/migration;
- no browser interpretation of policy verdicts or mandate validity;
- no generic provider onboarding;
- no transaction execution button in the administrative console.

## PR #43 — Agent integration kit

**Status: in progress.**

Give a design partner's engineer a small supported Node.js path to call Mino correctly without rebuilding the signing and retry protocol from internal implementation details.

Implemented candidate scope:

- a minimal `MinoAgentRequestSigner` that uses the same canonical signing payload and Ed25519 helper as the production verifier;
- a small `MinoACPAgentClient` for the current create/retrieve/update/cancel/complete ACP edge;
- Ed25519 key-generation bootstrap helper plus explicit private-key handling guidance;
- mandate attachment and local agent-binding sanity check without pretending client-side token decoding is verification;
- caller-owned stable idempotency helpers rather than hidden per-attempt key generation;
- a fresh timestamp/nonce/signature on every HTTP attempt so semantic retries are not replayed proofs;
- explicit completion retry advice for transaction approval and unresolved payment outcomes;
- no automatic mutation retry loop and no conversion of transport uncertainty into assumed failure;
- exact response classifications for success, block, approval, unresolved outcome, idempotency conflict, auth/protocol/upstream failure;
- design-partner documentation starting from key enrollment and mandate delivery through ALLOW/BLOCK/approval/reconciliation behavior;
- executable compatibility tests against the real `AgentRequestVerifier`.

The kit wraps existing protocol behavior. It does not move policy evaluation, mandate verification, merchant authority, nonce replay protection, spend reservation, payment outcome interpretation, or reconciliation authority into customer code.

## PR #44 — First design-partner execution path

Productionize exactly the provider/execution path the first serious design partner needs.

Stripe is already proven as a second provider behind the neutral execution/reconciliation boundaries, but provider choice for this slice should be customer-driven. The objective is not a generic provider marketplace.

Planned concerns include:

- production credential/configuration boundary;
- organization/provider target onboarding;
- exact grant-to-provider binding;
- safe reconciliation;
- pilot-safe sandbox/live environment separation;
- no Mino custody requirement;
- no provider-specific policy meaning.

## PR #45 — Pilot operations and release package

Make the hosted pilot supportable rather than merely runnable.

Planned scope:

- deploy/runbook for the hosted pilot environment;
- secret provisioning/rotation procedure;
- PostgreSQL backup/restore procedure;
- Redis loss/reconstruction procedure validation;
- monitoring and actionable alerts;
- audit-checkpoint retention procedure;
- upgrade/rollback procedure;
- pilot acceptance checklist;
- incident/support ownership;
- explicit sandbox-to-live promotion criteria.

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
5. at least one high-risk administrative four-eyes action;
6. immediate fail-closed mandate revocation;
7. reconciliation behavior for an uncertain/nonterminal provider outcome;
8. operator ability to find the resulting administrative and transaction audit evidence;
9. no design-partner code change required merely because execution-provider provenance changes while normalized economic meaning stays the same;
10. a credible answer to: "Would this team keep Mino enabled after the pilot?"

The most important commercial signal is not transaction volume. It is whether the partner treats Mino as necessary infrastructure they would otherwise have to build before trusting an autonomous agent with economic authority.
