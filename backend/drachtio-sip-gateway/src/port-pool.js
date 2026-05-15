'use strict';

/**
 * Bounded pool of UDP ports for RTP bridging.
 *
 * Previously (with rtpengine) these were loopback ports (17000-17048).
 * Now that the Node bridge speaks RTP directly with Chime, the ports
 * must be in the NLB-forwarded range (16000-16048) — the RTP target
 * registrar Lambda registers every task ENI as a target on each of
 * those 49 UDP ports, so traffic Chime sends to the NLB on one of
 * those ports lands on this task at the same port.
 *
 * Up to 49 simultaneous calls per task, matching the 49-UDP-listener
 * NLB cap (plus the one TCP/5060 SIP listener).
 */
class PortPool {
  constructor({ start = 16000, count = 49 } = {}) {
    this.start = start;
    this.count = count;
    this.free = [];
    for (let i = 0; i < count; i++) this.free.push(start + i);
  }

  size() {
    return this.count;
  }

  available() {
    return this.free.length;
  }

  allocate() {
    if (this.free.length === 0) return null;
    return this.free.shift();
  }

  release(port) {
    if (port == null) return;
    if (port < this.start || port >= this.start + this.count) return;
    if (this.free.includes(port)) return;
    this.free.push(port);
  }
}

module.exports = { PortPool };
