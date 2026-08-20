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

**Status: in progress.**

Make the existing administrative product identify itself in human terms before adding new customer authority.

Scope:

- expose enrolled organization name through `/access` while preserving the stable organization UUID;
- expose enrolled administrator display name/email through `/access` while preserving principal and membership IDs;
- treat those values as presentation-only metadata, never JWT-derived or authorization-bearing facts;
- make the console display human organization/administrator identity before technical UUIDs;
- keep technical identifiers available for audit/support;
- normalize post-#39 console/documentation language so implemented four-eyes governance is not described as deferred;
- document the concierge pilot boundary explicitly.

Non-goals:

- no new database authority;
- no browser login/OIDC flow;
- no user/beneficiary management yet;
- no policy semantic changes;
- no provider/runtime changes;
- no self-service organization signup.

## PR #41 — Beneficiary administration

Remove the largest current setup hole: mandate issuance should not require out-of-band database provisioning and copy/paste of beneficiary UUIDs.

Planned scope:

- organization-scoped beneficiary inventory/detail;
- create beneficiary using a narrow administrative permission;
- safe lifecycle behavior needed for pilot operation;
- human-readable selection during mandate proposal;
- signed administrative audit for actual beneficiary mutations;
- fail closed on organization mismatch and inactive beneficiary state;
- preserve the distinction between a spending-beneficiary `User` and an `AdminPrincipal`.

The exact lifecycle surface should remain minimal and be reconciled against current mandate semantics before implementation.

## PR #42 — Guided first-run setup and human money UX

Turn the existing collection of administration screens into an explicit pilot setup path.

Planned scope:

- setup progress across beneficiary → agent → policy → provider/counterparty → mandate governance;
- human-readable selectors instead of UUID-first fields where safe inventories already exist;
- currency-major-unit input/display for policy creation while preserving exact minor-unit backend values;
- sensible explanatory copy around mandate versus policy versus governance;
- clear empty states and next actions;
- no browser-side reinterpretation of authorization semantics.

## PR #43 — Agent integration kit

Give a design partner's engineer a small supported path to call Mino correctly.

Planned scope:

- minimal TypeScript/reference client rather than a broad SDK platform;
- agent key generation/reference handling guidance;
- exact request signing;
- mandate attachment;
- idempotency handling;
- safe retry/reconciliation behavior;
- examples for ALLOW, BLOCK, pending transaction approval, and governed authority setup;
- integration documentation that starts from a customer workflow rather than Mino internals.

The kit must wrap existing protocol behavior, not invent a weaker client-side authorization model.

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
