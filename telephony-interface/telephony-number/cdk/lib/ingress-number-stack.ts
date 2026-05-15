import * as cdk from 'aws-cdk-lib';
import {
  ChimePhoneNumber,
  PhoneCountry,
  PhoneNumberType,
  PhoneProductType,
} from 'cdk-amazon-chime-resources';
import { Construct } from 'constructs';

/**
 * `${prefix}-IngressNumberStack` — persistent Chime phone number (dial-in number).
 *
 * Split out of `IngressStack` so that operators can iterate on the telephony
 * plumbing (Voice Connector, SIP Media Application, SMA Lambda, SIP rule)
 * without re-ordering a Chime phone number on every redeploy. Chime phone
 * number orders are subject to inventory availability and are a non-trivial
 * operation to repeat (carriers can take minutes to release a released
 * number back to the orderable pool).
 *
 * Inputs (CfnParameters):
 *   - DeploymentPrefix — the shared project prefix (regex-validated locally
 *     per design §1.2 / R19). Only used for tagging / diagnostics here; the
 *     Chime phone-number resource itself has no prefix-able fields.
 *
 * Context (CDK `--context`):
 *   - `chimePhoneSearchKind`  — "toll-free" | "local"
 *   - `chimePhoneSearchValue` — 3-digit prefix/area-code (string)
 *   - `chimePhoneAreaCode`    — legacy manual override (3-digit number); used
 *                               only if the two search keys above are absent.
 *
 * Outputs (WITHOUT exportName, per P5):
 *   - `PhoneNumberE164` — e.g. `+18334228167`. Consumed by `IngressStack`
 *     (`SipRule.TriggerValue`) and echoed as the final "dial to test" line
 *     by `scripts/deploy-all.sh`.
 */
export class IngressNumberStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DeploymentPrefix — same regex as every other stack per R19. The Chime
    // phone-number construct does not expose any field that would let us
    // bake the prefix into the resource, but we declare the parameter so the
    // stack's invocation shape matches the rest of the project (enabling
    // consistent `--parameters Stack:DeploymentPrefix=…` plumbing in
    // `scripts/deploy-all.sh`).
    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
    });

    // Two input channels, identical to the old IngressStack block that we
    // moved here verbatim:
    //   1. `chimePhoneSearchKind` + `chimePhoneSearchValue` — auto-probed
    //      inventory shape from `scripts/deploy-all.sh`.
    //   2. `chimePhoneAreaCode` — legacy manual override for one-off
    //      operators doing a bare `cdk deploy` outside the shell script.
    const searchKindCtx = this.node.tryGetContext('chimePhoneSearchKind');
    const searchValueCtx = this.node.tryGetContext('chimePhoneSearchValue');
    const areaCodeCtx = this.node.tryGetContext('chimePhoneAreaCode');

    let phoneNumberProps: {
      phoneProductType: PhoneProductType;
      phoneNumberType?: PhoneNumberType;
      phoneCountry?: PhoneCountry;
      phoneAreaCode?: number;
      phoneNumberTollFreePrefix?: number;
    };

    if (searchKindCtx && searchValueCtx) {
      const numericValue = /^\d{3}$/.test(String(searchValueCtx))
        ? parseInt(String(searchValueCtx), 10)
        : NaN;
      if (!Number.isFinite(numericValue)) {
        throw new Error(
          `chimePhoneSearchValue must be a 3-digit string; got "${searchValueCtx}"`,
        );
      }
      if (searchKindCtx === 'toll-free') {
        phoneNumberProps = {
          phoneProductType: PhoneProductType.SMA,
          phoneNumberTollFreePrefix: numericValue,
        };
      } else if (searchKindCtx === 'local') {
        phoneNumberProps = {
          phoneProductType: PhoneProductType.SMA,
          phoneNumberType: PhoneNumberType.LOCAL,
          phoneCountry: PhoneCountry.US,
          phoneAreaCode: numericValue,
        };
      } else {
        throw new Error(
          `chimePhoneSearchKind must be "toll-free" or "local"; got "${searchKindCtx}"`,
        );
      }
    } else if (areaCodeCtx) {
      const n =
        typeof areaCodeCtx === 'number'
          ? areaCodeCtx
          : typeof areaCodeCtx === 'string' && /^\d{3}$/.test(areaCodeCtx)
          ? parseInt(areaCodeCtx, 10)
          : NaN;
      if (!Number.isFinite(n)) {
        throw new Error(
          `chimePhoneAreaCode must be a 3-digit string/number; got "${areaCodeCtx}"`,
        );
      }
      phoneNumberProps = {
        phoneProductType: PhoneProductType.SMA,
        phoneNumberType: PhoneNumberType.LOCAL,
        phoneCountry: PhoneCountry.US,
        phoneAreaCode: n,
      };
    } else {
      throw new Error(
        'No Chime phone-number search spec provided. scripts/deploy-all.sh ' +
          'auto-probes inventory and threads `chimePhoneSearchKind` + ' +
          '`chimePhoneSearchValue` as CDK context. For manual `cdk deploy` ' +
          'runs, supply `-c chimePhoneAreaCode=425` (or set the search ' +
          'context keys explicitly).',
      );
    }

    const phoneNumber = new ChimePhoneNumber(
      this,
      'PhoneNumber',
      phoneNumberProps,
    );

    // Tag the stack with the deployment prefix for cost/operational tracing.
    // (Individual Chime resources don't accept tags through the library, but
    // stack-level tags propagate to what CDK-native resources it contains.)
    cdk.Tags.of(this).add('DeploymentPrefix', deploymentPrefix.valueAsString);

    // ───────────── Outputs (NO exportName per P5) ─────────────
    new cdk.CfnOutput(this, 'PhoneNumberE164', {
      value: phoneNumber.phoneNumber,
      description:
        'E.164 phone number provisioned by Chime. Threaded into IngressStack as the SipRule TriggerValue and echoed as the final "dial to test" line by scripts/deploy-all.sh.',
    });
  }
}
