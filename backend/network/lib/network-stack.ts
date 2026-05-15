import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * {prefix}-NetworkStack — shared VPC for the telephony agent runtime.
 *
 * Per design §3(#3) and §9.1:
 * - Dedicated VPC, 2 AZs, private-with-egress subnets + NAT gateways (1 NAT GW is
 *   sufficient for this feature; design §9.1 calls for "NAT gateways" but the
 *   cost/resilience tradeoff lands on 1 NAT GW for the MVP — documented here and
 *   revisitable if an AZ-outage drill shows we need 2).
 * - One security group for the AgentCore Runtime ENIs, egress 443/tcp (all) for
 *   AWS API calls + egress UDP 1024-65535 (all) for WebRTC/TURN media.
 *
 * Wiring (r4 pattern — design §4.4, §4.5):
 * - INPUT: `DeploymentPrefix` CfnParameter (threaded by scripts/deploy-all.sh).
 *   The regex is re-declared locally (duplicated across the five new stacks —
 *   isolation priority beats DRY per tasks.md task 1.2).
 * - OUTPUTS: `VpcId`, `PrivateSubnetIds`, `AgentSecurityGroupId` — emitted as
 *   CfnOutput WITHOUT `exportName`. scripts/deploy-all.sh reads them from
 *   cdk-outputs/tel-network.json via json_val and passes them as
 *   --parameters to downstream stacks (runtime stack consumer).
 *
 * Physical-resource names and tags carry the `{DeploymentPrefix}` prefix (R19,
 * P12). Subnet names ("Private", "Public") are intentionally left as CDK
 * defaults — subnet IDs are what downstream consumers bind to.
 */
export class NetworkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ───────────── CfnParameter: DeploymentPrefix ─────────────
    // Regex and constraint message are deliberately duplicated across the five
    // new stacks so each CDK app is independently deployable without a shared
    // helper module (design §4.4 "r4 pattern").
    const deploymentPrefix = new cdk.CfnParameter(this, 'DeploymentPrefix', {
      type: 'String',
      allowedPattern: '^[a-z][a-z0-9-]{1,19}$',
      constraintDescription:
        'must be 1-20 chars, lowercase, starting with a letter',
    });
    const prefix = deploymentPrefix.valueAsString;

    // ───────────── CDK context: availabilityZones ─────────────
    // Bedrock AgentCore Runtime only supports a subset of AZs in each region.
    // As of 2026-05, us-east-1 support is limited to AZ IDs
    // `use1-az1`, `use1-az2`, `use1-az4` — and the AZ-ID-to-letter mapping is
    // RANDOMIZED PER ACCOUNT (e.g. one account's `us-east-1a` may be
    // `use1-az1` while another's is `use1-az6`). Pinning by letter alone is
    // unsafe.
    //
    // Why context instead of CfnParameter: `ec2.Vpc.availabilityZones` expects
    // a resolved string[] at SYNTH time; CfnParameter values are CFN tokens
    // that can't be iterated until deploy. Context values, by contrast, are
    // concrete at synth time.
    //
    // Resolution strategy: scripts/deploy-all.sh runs
    //   aws ec2 describe-availability-zones
    // for the target account, filters the returned AZs to those whose ZoneId
    // matches the Bedrock-supported set, and passes the first TWO matching
    // zone NAMES (letters) via `--context agentcoreAzs=us-east-1b,us-east-1c`.
    //
    // If Bedrock AgentCore ever expands to more AZs in us-east-1, update the
    // supported-ID allow-list in scripts/deploy-all.sh — no code change here.
    const agentcoreAzsCtx = this.node.tryGetContext('agentcoreAzs');
    if (!agentcoreAzsCtx) {
      throw new Error(
        'Context key `agentcoreAzs` is required. Pass 2 Bedrock AgentCore-supported ' +
          'AZ letter names via `--context agentcoreAzs=us-east-1b,us-east-1c`. ' +
          'scripts/deploy-all.sh resolves these automatically for the target account.',
      );
    }
    const availabilityZones = agentcoreAzsCtx.split(',').map((s: string) => s.trim());
    if (availabilityZones.length < 2) {
      throw new Error(
        `agentcoreAzs must contain at least 2 comma-delimited AZ names; got: "${agentcoreAzsCtx}"`,
      );
    }

    // ───────────── VPC ─────────────
    // 2 AZs pinned by name (letters) via the AvailabilityZones CfnParameter —
    // the orchestrator resolves Bedrock-supported AZ IDs → letters per-account
    // (see scripts/deploy-all.sh). 1 NAT GW is a cost choice for MVP; AZ-out
    // resilience is acceptable because an agent failure in the NAT-losing AZ
    // surfaces as a call drop, not a data-loss event.
    const vpc = new ec2.Vpc(this, 'TelVpc', {
      availabilityZones: availabilityZones,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });
    cdk.Tags.of(vpc).add('Name', cdk.Fn.sub('${P}-vpc', { P: prefix }));

    // ───────────── Agent Security Group ─────────────
    // Outbound-only; attached to the AgentCore Runtime ENIs. The runtime
    // itself is addressable only via the Bedrock InvokeAgentRuntime API —
    // there's no ingress from the VPC.
    const agentSg = new ec2.SecurityGroup(this, 'AgentSG', {
      vpc,
      description:
        'AgentCore Runtime ENIs - egress: 443/tcp (AWS APIs) + UDP 1024-65535 (WebRTC/TURN)',
      allowAllOutbound: false,
      securityGroupName: cdk.Fn.sub('${P}-agent-sg', { P: prefix }),
    });

    agentSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS to AWS service APIs (Bedrock, KVS, S3, Chime, SSM, etc.)',
    );

    agentSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udpRange(1024, 65535),
      'WebRTC/TURN media (KVS-managed TURN on ephemeral UDP ports)',
    );

    // ───────────── Outputs (NO exportName per P5 / r4 rule) ─────────────
    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC id — consumed by tel-agent-runtime via CfnParameter',
    });

    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: cdk.Fn.join(
        ',',
        vpc.privateSubnets.map((s) => s.subnetId),
      ),
      description:
        'Comma-delimited private subnet ids — consumed by tel-agent-runtime as a CommaDelimitedList CfnParameter',
    });

    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: cdk.Fn.join(
        ',',
        vpc.publicSubnets.map((s) => s.subnetId),
      ),
      description:
        'Comma-delimited public subnet ids - consumed by tel-sip-gateway to place its internet-facing NLB',
    });

    new cdk.CfnOutput(this, 'AgentSecurityGroupId', {
      value: agentSg.securityGroupId,
      description:
        'Security group for AgentCore Runtime ENIs — consumed by tel-agent-runtime via CfnParameter',
    });
  }
}
