# IngressNumberStack

Persistent Chime phone number, split out of `IngressStack` so iterating on the
telephony plumbing (Voice Connector, SMA, SIP rule, SMA Lambda) does not
re-order a phone number on every redeploy.

## Inputs

### CfnParameters

| Name | Type | Validator | Description |
|---|---|---|---|
| `DeploymentPrefix` | String | `^[a-z][a-z0-9-]{1,19}$` | Shared project prefix. Used for stack-level tagging only — the Chime phone-number resource has no prefix-able fields. |

### CDK `--context` keys

| Key | Type | Description |
|---|---|---|
| `chimePhoneSearchKind` | `toll-free` \| `local` | Resolved by `scripts/deploy-all.sh` from inventory probe. |
| `chimePhoneSearchValue` | 3-digit string | Toll-free prefix (e.g. `844`) or local area code (e.g. `425`). |
| `chimePhoneAreaCode` | 3-digit string/number | Legacy manual override. Only used if `chimePhoneSearchKind` / `chimePhoneSearchValue` are both absent. |

## Outputs

| Logical id | Value | Consumer |
|---|---|---|
| `PhoneNumberE164` | E.164 string (e.g. `+18334228167`) | `IngressStack` via `SipRule.TriggerValue` CfnParameter. Echoed by `deploy-all.sh` as the final "dial to test" line. |

## Why a separate stack

`ChimePhoneNumber` (from `cdk-amazon-chime-resources`) provisions a number by
calling Chime's `search-available-phone-numbers` + `createPhoneNumberOrder`
APIs at stack-create time. Releasing a number on stack delete is
synchronous, but re-ordering after release may hit inventory gaps on the
carrier side. Pulling the resource into its own long-lived stack lets the
downstream `IngressStack` be recreated freely without affecting the number.

## Deploy

`scripts/deploy-all.sh` deploys this stack as Layer 10a (between
AgentRuntime and Ingress). For a manual one-off:

```bash
cd telephony-interface/telephony-number/cdk
npx cdk deploy IngressNumberStack \
  --parameters IngressNumberStack:DeploymentPrefix=qsr-tel \
  -c chimePhoneSearchKind=toll-free \
  -c chimePhoneSearchValue=844 \
  --outputs-file ../../../cdk-outputs/tel-ingress-number.json
```
