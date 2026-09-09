# Mino pilot acceptance checklist

Use this on the **hosted sandbox** organization before claiming design-partner readiness or starting outreach.

Product owns the wedge narrative; Eng owns that each step is runnable against current `main`; Security signs live promotion separately (`docs/PILOT_OPS_PACKAGE.md` section 8).

Record: partner name, date (America/New_York), `main` SHA, operator(s), pass/fail per row.

## Preconditions

- [ ] Hosted pilot env up; `/healthz` and `/readyz` pass
- [ ] Secrets provisioned per `docs/PILOT_OPS_PACKAGE.md` section 2 (sandbox provider creds only)
- [ ] At least 2 distinct admin principals with required permissions (four-eyes real)
- [ ] One beneficiary, one keyed agent, one active policy path, one provider/merchant target for the wedge
- [ ] GitHub verification gate green on the deployed SHA

## Timing

- [ ] Credentials/setup to first governed **sandbox** transaction in under about 1 hour with Mino concierge help

## Economic path proofs

- [ ] At least one real **ALLOW** (sandbox)
- [ ] At least one policy **BLOCK**
- [ ] At least one **transaction-level human approval** (soft-limit path): approve, then exact idempotent retry, then merchant/provider-authoritative revalidation before ALLOW
- [ ] Immediate **fail-closed mandate revoke** (subsequent agent attempts denied without waiting on four-eyes)

## Administrative governance

- [ ] At least one **four-eyes** high-risk admin action (`mandate.issue` or `policy.activate`): distinct proposer/approver, explicit apply, and for mandate one-time bearer only at apply

## Reconciliation and audit

- [ ] Uncertain / nonterminal provider outcome stays **nonterminal** (no invented success/failure); reconciliation hold retained until provider-authoritative resolution
- [ ] Operators can find **administrative** and **transaction** audit evidence for the above actions; `audit.verify` passes for the org

## Provider-neutrality signal

- [ ] Credible demonstration that provider provenance/transport can change while normalized economic meaning / policy evaluation stay the same

## Commercial signal

- [ ] Partner (or internal proxy for the wedge) answers: would this team **keep Mino enabled** after the pilot?

## Sign-off

| Role | Name | Result | Notes |
| --- | --- | --- | --- |
| Eng | | pass / fail | |
| Product | | pass / fail | |
| Security (sandbox only) | | pass / fail | |
| Company lead | | pass / fail | |

**Live money:** not part of this checklist. Requires ops drills + Security live-money pass + explicit founder confirmation.
