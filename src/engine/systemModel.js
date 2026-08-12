'use strict';
/**
 * Closed-loop system model.
 *
 * A stylized but physically-motivated (queueing-theoretic) model of a
 * horizontally-scaled service. Given demand (rps) and the current replica
 * count, it derives CPU, RAM, connection-pool utilization, backlog, and
 * latency percentiles (p50/p90/p99) tick by tick. Controllers observe these
 * signals and decide replica counts; the model then reacts to the new
 * replica count on the next tick, closing the loop.
 *
 * This intentionally does not require Kubernetes: replicas/nodes are
 * abstract capacity units simulated in-process.
 */

const PER_REPLICA_CAPACITY = 50; // rps a single replica can serve at rho=1
const BASE_SERVICE_TIME_MS = 20; // mean service time per request
const POOL_MAX_PER_REPLICA = 30; // max pooled connections per replica
const CONN_PER_REQUEST = 8; // effective connections held per in-flight request (keep-alive + downstream fan-out)
const BASELINE_ACTIVE_CONN = 5; // idle/keep-alive connections held regardless of instantaneous load
const SLOTS_PER_NODE = 10; // replica slots provisioned per node
const NODE_BOOT_DELAY_S = 45; // time for a new node to become schedulable

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class SystemModel {
  /**
   * @param {object} opts
   * @param {number} opts.seed
   * @param {number} opts.initialReplicas
   */
  constructor(opts = {}) {
    this.rand = mulberry32(opts.seed ?? 1234);
    this.replicas = opts.initialReplicas ?? 4;
    this.desiredReplicas = this.replicas;
    this.backlog = 0; // excess unserved requests (rps-seconds)
    this.ram = 35; // %
    this.cpuEwma = 20; // %
    this.nodesProvisioned = Math.max(1, Math.ceil(this.replicas / SLOTS_PER_NODE));
    this.availableSlots = this.nodesProvisioned * SLOTS_PER_NODE;
    this.pendingNodeArrivals = []; // [{arrivesAt, slots}]
    this.t = 0;
    this.ramPhase = this.rand() * 1000;
    this.recentUtil = []; // rolling window for RAM target smoothing
  }

  _gaussian(mu, sigma) {
    const u1 = Math.max(this.rand(), 1e-9);
    const u2 = this.rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mu + sigma * z;
  }

  /** Request a new desired replica count (from a controller). Subject to node schedulability. */
  requestReplicas(desired, noiseFactor) {
    this.desiredReplicas = desired;
  }

  /** Advance node provisioning: process any node arrivals, request new nodes if short on slots. */
  _stepNodes(dt) {
    // process arrivals
    this.pendingNodeArrivals = this.pendingNodeArrivals.filter((n) => {
      if (this.t >= n.arrivesAt) {
        this.nodesProvisioned += 1;
        this.availableSlots += n.slots;
        return false;
      }
      return true;
    });
    const neededSlots = this.desiredReplicas;
    if (neededSlots > this.availableSlots + this.pendingNodeArrivals.length * SLOTS_PER_NODE) {
      // trigger provisioning of enough nodes to cover the shortfall
      const shortfall = neededSlots - (this.availableSlots + this.pendingNodeArrivals.length * SLOTS_PER_NODE);
      const nodesToAdd = Math.ceil(shortfall / SLOTS_PER_NODE);
      for (let i = 0; i < nodesToAdd; i++) {
        this.pendingNodeArrivals.push({ arrivesAt: this.t + NODE_BOOT_DELAY_S, slots: SLOTS_PER_NODE });
      }
    }
    // effective replicas are capped by currently available (schedulable) slots
    this.replicas = Math.max(1, Math.min(this.desiredReplicas, this.availableSlots));
  }

  /** Advance the simulation by one tick given current demand (rps). Returns observed signal snapshot. */
  step(demandRps, dt = 1) {
    this._stepNodes(dt);
    const capacity = this.replicas * PER_REPLICA_CAPACITY;
    const rawUtil = demandRps / capacity;
    const rho = Math.min(rawUtil, 0.995);

    // Backlog dynamics: accumulate excess demand beyond capacity, drain otherwise.
    const excess = demandRps - capacity * 0.995;
    if (excess > 0) {
      this.backlog = this.backlog + excess * dt;
    } else {
      this.backlog = Math.max(0, this.backlog + excess * dt); // excess negative here => drains
    }
    const pendingUnschedulable = Math.max(0, this.desiredReplicas - this.replicas);

    // Latency percentiles via M/M/1-style response-time tail: T_p = -ln(1-p) * baseService/(1-rho)
    const denom = Math.max(1 - rho, 0.005);
    const backlogDelayMs = (this.backlog / Math.max(capacity, 1)) * 1000; // time to drain backlog at current capacity
    const noiseSigma = 0.12;
    const noiseMul = Math.max(0.5, 1 + this._gaussian(0, noiseSigma));
    const p50 = (Math.log(2) * BASE_SERVICE_TIME_MS) / denom + backlogDelayMs;
    let p90 = ((Math.log(10) * BASE_SERVICE_TIME_MS) / denom + backlogDelayMs) * noiseMul;
    let p99 = ((Math.log(100) * BASE_SERVICE_TIME_MS) / denom + backlogDelayMs) * noiseMul;

    // CPU: proportional to utilization with slight overhead, EWMA smoothed (metrics-server-like lag)
    const cpuTarget = Math.min(100, rho * 100 * 1.05 + Math.max(0, (demandRps > capacity ? (demandRps - capacity) / capacity : 0)) * 40 + this._gaussian(0, 3));
    this.cpuEwma = this.cpuEwma + 0.3 * (cpuTarget - this.cpuEwma);
    const cpu = Math.max(2, Math.min(100, this.cpuEwma));

    // RAM: slower dynamics + small sawtooth (GC-like) + inverse relation to replica count (fixed per-pod overhead)
    this.recentUtil.push(rho);
    if (this.recentUtil.length > 60) this.recentUtil.shift();
    const avgUtil = this.recentUtil.reduce((a, b) => a + b, 0) / this.recentUtil.length;
    const perPodOverhead = 8 / Math.sqrt(this.replicas);
    const sawtooth = 4 * Math.abs(((this.t + this.ramPhase) % 120) / 120 - 0.5) * 2;
    const ramTarget = 28 + 55 * avgUtil + perPodOverhead + sawtooth + this._gaussian(0, 2);
    this.ram = this.ram + 0.05 * (Math.max(5, Math.min(98, ramTarget)) - this.ram);

    // Connection pool: Little's Law L = lambda * W, plus a baseline of
    // idle/keep-alive connections and a per-request connection multiplier
    // (keep-alive reuse + downstream fan-out) so typical utilization sits in
    // a realistic operating band rather than near zero.
    const lambdaPerReplica = demandRps / this.replicas;
    const wSeconds = p50 / 1000;
    const activePerReplica = BASELINE_ACTIVE_CONN + lambdaPerReplica * wSeconds * CONN_PER_REQUEST;
    let poolUtil = Math.max(0, Math.min(100, (activePerReplica / POOL_MAX_PER_REPLICA) * 100 + this._gaussian(0, 1)));

    // Backpressure: pool exhaustion adds extra latency (feedback loop)
    if (poolUtil > 90) {
      const penalty = 1 + Math.max(0, (poolUtil - 90) / 10) * 0.5;
      p90 *= penalty;
      p99 *= penalty;
    }

    this.t += dt;

    return {
      t: this.t,
      demandRps,
      replicas: this.replicas,
      desiredReplicas: this.desiredReplicas,
      nodesProvisioned: this.nodesProvisioned,
      pendingUnschedulable,
      backlog: this.backlog,
      utilization: rho,
      cpu,
      ram: this.ram,
      p50,
      p90,
      p99,
      connPoolUtil: poolUtil,
    };
  }
}

module.exports = { SystemModel, PER_REPLICA_CAPACITY, SLOTS_PER_NODE, NODE_BOOT_DELAY_S, POOL_MAX_PER_REPLICA };
