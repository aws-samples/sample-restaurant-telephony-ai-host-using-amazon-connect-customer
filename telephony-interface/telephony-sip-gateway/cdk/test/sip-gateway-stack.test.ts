/**
 * Synth-time security invariants for `${prefix}-SipGatewayStack`.
 *
 * These tests SHOULD fail the deploy if any of the r7 security invariants
 * drifts (design §20.2, requirements R27 / R28 / R31). They run against
 * the synthesized CloudFormation template — no AWS credentials, no
 * network, pure local check.
 *
 * Invariants enforced here:
 *   - R27: task SG UDP 16000-16048 ingress source list includes the
 *     pinned Chime VC CIDR allowlist verbatim. Zero `0.0.0.0/0`
 *     anywhere on the task SG.
 *   - R28: task SG TCP 5060 ingress source is ONLY the NLB SG (no
 *     direct-internet TCP-5060 ingress on tasks).
 *   - R31: the Chime CIDR constants in `sip-gateway-stack.ts` carry the
 *     documented us-east-1 set. A config-level guard against accidental
 *     deletion or regional drift.
 *
 * CDK encodes ingress rules in two places depending on whether a rule
 * would introduce a circular SG reference:
 *   - Inline on the `AWS::EC2::SecurityGroup.SecurityGroupIngress` array
 *     (for rules with a CIDR source, or for self-referencing rules).
 *   - As a standalone `AWS::EC2::SecurityGroupIngress` resource
 *     (for rules with a peer-SG source when the peer lives in a
 *     different SG definition).
 *
 * `collectTaskSgIngress()` walks both and yields a single unified list,
 * each entry normalized to `{ protocol, from, to, cidr, sourceSgRef }`.
 */

import * as cdk from 'aws-cdk-lib';
import {
  CHIME_VC_MEDIA_CIDRS,
  CHIME_VC_SIGNALING_CIDRS,
  SipGatewayStack,
} from '../lib/sip-gateway-stack';

interface NormalizedIngress {
  protocol: string | undefined;
  from: number | undefined;
  to: number | undefined;
  cidr: string | undefined;
  sourceSg: string | undefined;
}

function synth() {
  const app = new cdk.App();
  const stack = new SipGatewayStack(app, 'TestSipGatewayStack', {
    env: { region: 'us-east-1' },
  });
  return app.synth().getStackByName('TestSipGatewayStack').template as {
    Resources: Record<
      string,
      { Type: string; Properties: Record<string, unknown> }
    >;
  };
}

function matchesSgLogicalId(ref: unknown, needle: RegExp): boolean {
  // Refs to other resources take many shapes. Normalize to string and
  // pattern-match.
  return needle.test(JSON.stringify(ref ?? ''));
}

function collectTaskSgIngress(
  template: ReturnType<typeof synth>,
): NormalizedIngress[] {
  const out: NormalizedIngress[] = [];
  for (const [logicalId, res] of Object.entries(template.Resources)) {
    // Inline rules live on the SG itself.
    if (res.Type === 'AWS::EC2::SecurityGroup' && /Task/i.test(logicalId)) {
      const inline = (res.Properties.SecurityGroupIngress ?? []) as Array<
        Record<string, unknown>
      >;
      for (const r of inline) {
        out.push({
          protocol: r.IpProtocol as string | undefined,
          from: r.FromPort as number | undefined,
          to: r.ToPort as number | undefined,
          cidr: r.CidrIp as string | undefined,
          sourceSg: r.SourceSecurityGroupId
            ? JSON.stringify(r.SourceSecurityGroupId)
            : undefined,
        });
      }
    }
    // Standalone ingress resources reference the task SG via GroupId.
    if (res.Type === 'AWS::EC2::SecurityGroupIngress') {
      if (!matchesSgLogicalId(res.Properties.GroupId, /Task/i)) continue;
      out.push({
        protocol: res.Properties.IpProtocol as string | undefined,
        from: res.Properties.FromPort as number | undefined,
        to: res.Properties.ToPort as number | undefined,
        cidr: res.Properties.CidrIp as string | undefined,
        sourceSg: res.Properties.SourceSecurityGroupId
          ? JSON.stringify(res.Properties.SourceSecurityGroupId)
          : undefined,
      });
    }
  }
  return out;
}

function collectNlbSgIngress(
  template: ReturnType<typeof synth>,
): NormalizedIngress[] {
  const out: NormalizedIngress[] = [];
  for (const [logicalId, res] of Object.entries(template.Resources)) {
    if (res.Type === 'AWS::EC2::SecurityGroup' && /Nlb/i.test(logicalId)) {
      const inline = (res.Properties.SecurityGroupIngress ?? []) as Array<
        Record<string, unknown>
      >;
      for (const r of inline) {
        out.push({
          protocol: r.IpProtocol as string | undefined,
          from: r.FromPort as number | undefined,
          to: r.ToPort as number | undefined,
          cidr: r.CidrIp as string | undefined,
          sourceSg: r.SourceSecurityGroupId
            ? JSON.stringify(r.SourceSecurityGroupId)
            : undefined,
        });
      }
    }
    if (res.Type === 'AWS::EC2::SecurityGroupIngress') {
      if (!matchesSgLogicalId(res.Properties.GroupId, /Nlb/i)) continue;
      out.push({
        protocol: res.Properties.IpProtocol as string | undefined,
        from: res.Properties.FromPort as number | undefined,
        to: res.Properties.ToPort as number | undefined,
        cidr: res.Properties.CidrIp as string | undefined,
        sourceSg: res.Properties.SourceSecurityGroupId
          ? JSON.stringify(res.Properties.SourceSecurityGroupId)
          : undefined,
      });
    }
  }
  return out;
}

describe('SipGatewayStack security invariants (r7)', () => {
  test('R31 — Chime VC CIDR constants carry the documented us-east-1 set', () => {
    expect([...CHIME_VC_SIGNALING_CIDRS]).toEqual(['3.80.16.0/23']);
    expect([...CHIME_VC_MEDIA_CIDRS]).toEqual([
      '3.80.16.0/23',
      '52.55.62.128/25',
      '52.55.63.0/25',
      '34.212.95.128/25',
      '34.223.21.0/25',
    ]);
  });

  test('R27 — task SG has zero 0.0.0.0/0 ingress rules', () => {
    const template = synth();
    const rules = collectTaskSgIngress(template);
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r.cidr).not.toBe('0.0.0.0/0');
    }
  });

  test('R27 — task SG UDP 16000-16048 ingress includes every Chime VC media CIDR', () => {
    const template = synth();
    const rules = collectTaskSgIngress(template);

    const udpRules = rules.filter(
      (r) => r.protocol === 'udp' && r.from === 16000 && r.to === 16048,
    );
    const cidrSources = udpRules
      .map((r) => r.cidr)
      .filter((v): v is string => typeof v === 'string')
      .sort();

    for (const cidr of CHIME_VC_MEDIA_CIDRS) {
      expect(cidrSources).toContain(cidr);
    }

    // Post task 11.10: zero SG-sourced UDP ingress on the task SG.
    // Every UDP 16000-16048 rule MUST be CIDR-based (Chime VC only).
    for (const r of udpRules) {
      expect(r.sourceSg).toBeUndefined();
    }
  });

  test('R28 — task SG TCP 5060 ingress is ONLY from the NLB SG', () => {
    const template = synth();
    const rules = collectTaskSgIngress(template);

    const tcp5060 = rules.filter(
      (r) => r.protocol === 'tcp' && r.from === 5060 && r.to === 5060,
    );
    expect(tcp5060.length).toBeGreaterThan(0);

    for (const r of tcp5060) {
      // No CIDR source — TCP/5060 must be SG-scoped only.
      expect(r.cidr).toBeUndefined();
      expect(r.sourceSg).toBeDefined();
      expect(r.sourceSg as string).toMatch(/Nlb/i);
    }
  });

  test('NLB SG sanity — signaling CIDRs present on public ingress (r7: TCP-only)', () => {
    // r7: the NLB is TCP-only (task 11.10 removed all UDP listeners),
    // so the NLB SG only needs the Chime VC SIGNALING CIDRs on TCP
    // 5060. Media CIDRs are on the task SG directly. This is a
    // regression guard.
    const template = synth();
    const rules = collectNlbSgIngress(template);
    const cidrSet = new Set<string>();
    for (const r of rules) {
      if (r.cidr) cidrSet.add(r.cidr);
    }
    for (const cidr of CHIME_VC_SIGNALING_CIDRS) {
      expect(cidrSet.has(cidr)).toBe(true);
    }
  });

  // Post-11.10 steady state: task SG UDP ingress MUST be CIDR-only.
  // The r6 "UDP from NLB SG" ingress rule is removed; any SG-sourced
  // UDP rule would indicate a regression.
  describe('R28 — r7 steady state (post task 11.10)', () => {
    test('task SG UDP ingress has NO SG-sourced rules (CIDR-only)', () => {
      const template = synth();
      const rules = collectTaskSgIngress(template);
      const udp = rules.filter((r) => r.protocol === 'udp');
      for (const r of udp) {
        expect(r.sourceSg).toBeUndefined();
      }
    });
  });
});
