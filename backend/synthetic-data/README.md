# backend/synthetic-data

Interactive + non-interactive CLI tool that seeds the telephony
DynamoDB tables (Locations / Customers / Menu / Orders) with realistic
test data. Ported and adapted from
`reference-project/backend/synthetic-data/` — see `NOTICE.md` for the
commit pin and the list of telephony-specific adaptations.

## What this does

1. Reads Amazon Location Service to discover real businesses near an
   address (or coordinates) you supply.
2. Generates Location / Customer / Menu / Order rows matching the
   reference-project DynamoDB schema — the same schema the ported
   `backend/backend-infrastructure/` Lambdas consume.
3. Writes everything to the telephony DynamoDB tables via
   `BatchWriteItem`.

The single seeded customer is the "known caller" used when you dial
the telephony agent from a specific phone for loyalty-greeting testing.

## Prereqs

1. **`tel-ddb` deployed.** Table names come from
   `cdk-outputs/tel-ddb.json` (produced by
   `scripts/deploy-all.sh` after it deploys the `DynamoDBStack` layer).
2. **`tel-agent-runtime` deployed.** The runtime stack provisions the
   `customer-id-pepper` SSM SecureString at
   `/${deploymentPrefix}/customer-id-pepper`. This script reads that
   same secret so the `customerId` it writes matches what the live
   agent computes at call time.
3. **AWS credentials** in the shell (`ada credentials update
   --account=... --provider=isengard --role=Admin --once`).
4. **Node.js >= 24.**

## Usage

### Interactive

```bash
cd backend/synthetic-data
npm install
node populate-data.js \
  --user-name  "Jane Doe" \
  --user-phone "+12125550100"
# Script prompts for location, business type, confirmations.
```

### Non-interactive (driven by `scripts/deploy-all.sh`)

```bash
node populate-data.js \
  --user-name          "Jane Doe" \
  --user-phone         "+12125550100" \
  --location           "Dallas, TX" \
  --business-name      "burgers" \
  --company-name       "Example Cafe" \
  --deployment-prefix  qsr-tel \
  --non-interactive
```

### Cleanup

```bash
node cleanup-data.js           # interactive confirm
node cleanup-data.js --force   # unattended
```

## Customer id derivation

The live telephony agent derives a pseudonymous `customerId` from each
inbound caller's E.164 number:

```
customerId = "pstn-" + sha256(e164 + pepper).hexdigest()[:16]
```

The pepper is a per-deployment SSM SecureString at
`/${deploymentPrefix}/customer-id-pepper`.

`populate-data.js` reads the same SSM value and computes the same
hash, so the Customers row it writes (PK
`CUSTOMER#pstn-<hash>` / SK `PROFILE`) will be the row the agent reads
on the first inbound call from the number you passed as
`--user-phone`.

If you rotate the pepper (unlikely — it is regenerated only on a
fresh `tel-agent-runtime` deploy), you must re-run `populate-data.js`
or `cleanup-data.js --force` so the old orphaned customer row
disappears.

## Generated data shapes

| Table      | PK                                     | SK                             |
|------------|----------------------------------------|--------------------------------|
| Locations  | `LOCATION#<locationId>`                | (none)                         |
| Customers  | `CUSTOMER#<customerId>`                | `PROFILE`                      |
| Menu       | `LOCATION#<locationId>#ITEM#<itemId>`  | (none)                         |
| Orders     | `CUSTOMER#<customerId>`                | `ORDER#<orderId>#<unix-ts>`    |

Matches reference-project schema so the backend Lambdas work
unchanged.

## Related files

- `backend/agentcore-runtime-telephony/agent/pstn_customer.py` —
  Python side of the customer-id derivation; must stay in lockstep
  with `lib/customer-id.js`.
- `backend/agentcore-runtime-telephony/cdk/runtime/lib/runtime-stack.ts`
  — provisions the pepper SSM parameter read here.
- `scripts/deploy-all.sh` — invokes `populate-data.js` in
  `--non-interactive` mode when `--with-synthetic-data` is passed.
