# Notice — Synthetic Data Generator Provenance

Ported from reference-project/backend/synthetic-data/ at commit
a582cae3f4660ebba2a83e8386f095228c6170d3 (dev, 2026-05-06).

Adaptations for the telephony-voice-ordering-agent feature:

1. **No Cognito dependency.** The reference project derives the seeded
   customer's `customerId` from the Cognito AppUser created by
   `QSR-CognitoStack`. This project ships without Cognito (design §8
   non-goal #8). The seeded customer identity is derived the same way
   the live agent derives it at call time — `pstn-<sha256(e164+pepper)[:16]>`
   — using the pepper read from the SSM SecureString that the agent
   runtime also reads (`/${prefix}/customer-id-pepper`). This ensures
   the seeded Customers row's PK matches the customer_id the agent
   computes on the first inbound call from the provided phone number.

2. **`--user-email` replaced by `--user-phone`.** Primary caller identity
   is the phone number in E.164 format. A synthetic email is generated
   deterministically (`<slug(name)>@example.com`) so the
   `email` attribute on the Customers row stays populated for schema
   compatibility with the reference `get-customer-profile` Lambda.

3. **Deploy-script integration.** `scripts/deploy-all.sh` accepts
   `--user-name` + `--user-phone` + `--with-synthetic-data` /
   `--skip-synthetic-data` flags, mirroring the reference
   `reference-project/deploy-all.sh` shape. The synthetic-data layer is
   deployed as component key `tel-synthetic-data` and runs after
   `tel-agent-runtime` (the layer that provisions the SSM pepper).

4. **Table-name source.** Table names are read from
   `cdk-outputs/tel-ddb.json`, keyed on the unprefixed logical stack id
   `DynamoDBStack` (not `QSR-DynamoDBStack` — this project's backend-
   infrastructure port uses unprefixed logical ids so `cdk deploy
   <UnprefixedName>` works with per-layer `--outputs-file`).

See `backend/synthetic-data/README.md` for the live contract.
