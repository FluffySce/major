'use strict';
/**
 * Autoscaling controllers.
 *
 * Three reactive baselines reproduce the paper's evaluated configurations
 * (Default HPA, Tuned HPA, HPA+VPA-recommendation-mode). The fourth,
 * ProactiveMultiSignalController, is this project's contribution: it
 * forecasts p90/p99 latency, CPU, RAM and connection-pool utilization
 * `horizonS` seconds ahead with Holt's linear trend and scales ahead of
 * demand, subject to cost-aware and stability guardrails.
 *
 * All controllers share bounds MIN_REPLICAS/MAX_REPLICAS and are evaluated
 * on the same control cadence so comparisons are fair.
 */
const { HoltLinearForecaster, CombinedForecaster } = require('./forecaster');

const MIN_REPLICAS = 2;
const MAX_REPLICAS = 60;
const SLO_P99_MS = 300;

function clampReplicas(n) {
  return Math.max(MIN_REPLICAS, Math.min(MAX_REPLICAS, Math.round(n)));
}

/** Base class: shared scale-down stabilization-window bookkeeping. */
class BaseController {
  constructor({ controlIntervalS }) {
    this.controlIntervalS = controlIntervalS;
    this.recommendationHistory = []; // {t, recommendation}
    this.lastReplicas = 4;
    this.lastActionT = -Infinity;
    this.name = 'base';
  }

  _recordAndStabilizeDown(t, recommendation, windowS) {
    this.recommendationHistory.push({ t, recommendation });
    this.recommendationHistory = this.recommendationHistory.filter((r) => t - r.t <= windowS);
    if (recommendation < this.lastReplicas) {
      // only scale down to the max recommendation seen across the window (conservative)
      const maxInWindow = Math.max(...this.recommendationHistory.map((r) => r.recommendation));
      return maxInWindow;
    }
    return recommendation;
  }
}

class DefaultHPAController extends BaseController {
  constructor(opts) {
    super(opts);
    this.name = 'default_hpa';
    this.targetCpu = 70;
    this.scaleDownWindowS = 300;
  }

  decide(t, snapshot) {
    const raw = (snapshot.replicas * snapshot.cpu) / this.targetCpu;
    let desired = this._recordAndStabilizeDown(t, raw, this.scaleDownWindowS);
    // default HPA allows doubling per sync but no explicit down step limit beyond stabilization
    const maxUp = this.lastReplicas * 2;
    desired = Math.min(desired, maxUp);
    desired = clampReplicas(desired);
    this.lastReplicas = desired;
    return { desiredReplicas: desired, meta: { trigger: 'cpu', targetCpu: this.targetCpu, raw } };
  }
}

class TunedHPAController extends BaseController {
  constructor(opts) {
    super(opts);
    this.name = 'tuned_hpa';
    this.targetCpu = 60;
    this.targetP99 = 250;
    this.scaleDownWindowS = 120;
  }

  decide(t, snapshot) {
    const cpuRec = (snapshot.replicas * snapshot.cpu) / this.targetCpu;
    const latRec = (snapshot.replicas * snapshot.p99) / this.targetP99;
    const raw = Math.max(cpuRec, latRec);
    let desired = this._recordAndStabilizeDown(t, raw, this.scaleDownWindowS);
    const maxUp = this.lastReplicas * 2;
    const maxDown = this.lastReplicas * 0.5;
    desired = Math.min(desired, maxUp);
    desired = Math.max(desired, maxDown);
    desired = clampReplicas(desired);
    this.lastReplicas = desired;
    return { desiredReplicas: desired, meta: { trigger: cpuRec >= latRec ? 'cpu' : 'latency', cpuRec, latRec } };
  }
}

class HpaVpaController extends BaseController {
  constructor(opts) {
    super(opts);
    this.name = 'hpa_vpa';
    this.targetCpu = 60;
    this.targetP99 = 250;
    this.targetRam = 75;
    this.scaleDownWindowS = 120;
  }

  decide(t, snapshot) {
    const cpuRec = (snapshot.replicas * snapshot.cpu) / this.targetCpu;
    const latRec = (snapshot.replicas * snapshot.p99) / this.targetP99;
    const ramRec = (snapshot.replicas * snapshot.ram) / this.targetRam;
    const raw = Math.max(cpuRec, latRec, ramRec);
    let desired = this._recordAndStabilizeDown(t, raw, this.scaleDownWindowS);
    const maxUp = this.lastReplicas * 2;
    const maxDown = this.lastReplicas * 0.5;
    desired = Math.min(desired, maxUp);
    desired = Math.max(desired, maxDown);
    desired = clampReplicas(desired);
    this.lastReplicas = desired;
    return { desiredReplicas: desired, meta: { trigger: 'multi-metric-reactive', cpuRec, latRec, ramRec } };
  }
}

/**
 * Reactive Multi-Signal controller: identical signal set, thresholds, risk
 * fusion, backlog handling, and guardrails as ProactiveMultiSignalController
 * below, but evaluated on the *current* value of each signal instead of a
 * forecast. This is not one of the paper's original three reactive
 * baselines (Default HPA, Tuned HPA, HPA+VPA); it exists specifically to
 * isolate the marginal contribution of forecasting itself, holding every
 * other design choice (which signals, which thresholds, which guardrails)
 * fixed -- otherwise any improvement from the proactive controller is
 * confounded with it simply having access to more signals than the
 * baselines it is compared against.
 */
class ReactiveMultiSignalController extends BaseController {
  constructor(opts) {
    super(opts);
    this.name = 'reactive_multi_signal';
    this.sloP99Trigger = 250;
    this.cpuTarget = 60;
    this.ramTarget = 75;
    this.poolTarget = 85;
    this.stabDownWindowS = 120;
    this.cooldownS = 15;
    this.maxStepUp = 2.0;
    this.maxStepDown = 0.5;
  }

  decide(t, snapshot) {
    const riskP99 = snapshot.p99 / this.sloP99Trigger;
    const riskCpu = snapshot.cpu / this.cpuTarget;
    const riskRam = snapshot.ram / this.ramTarget;
    const riskPool = snapshot.connPoolUtil / this.poolTarget;
    const risk = Math.max(riskP99, riskCpu, riskRam, riskPool);
    const desiredFromRisk = snapshot.replicas * risk;

    const drainTargetS = 30;
    const perReplicaCapacity = 50;
    const backlogReplicas = snapshot.backlog / (drainTargetS * perReplicaCapacity);
    const rawDesired = desiredFromRisk + backlogReplicas;

    let desired = this._recordAndStabilizeDown(t, rawDesired, this.stabDownWindowS);
    const maxUp = this.lastReplicas * this.maxStepUp;
    const maxDown = this.lastReplicas * this.maxStepDown;
    desired = Math.min(desired, maxUp);
    desired = Math.max(desired, maxDown);

    if (desired !== this.lastReplicas && t - this.lastActionT < this.cooldownS) {
      desired = this.lastReplicas;
    }
    desired = clampReplicas(desired);
    if (desired !== this.lastReplicas) this.lastActionT = t;
    this.lastReplicas = desired;

    return {
      desiredReplicas: desired,
      meta: { trigger: 'reactive-multi-signal', risk, riskP99, riskCpu, riskRam, riskPool },
    };
  }
}

/**
 * Proposed proactive, multi-signal, SLO- and cost-aware controller.
 * Extends the reference paper's decision pipeline (signal aggregation ->
 * SLO-driven estimation -> workload-sensitivity adjustment -> guardrails ->
 * coordinated actuation) with explicit forecasting over 5 signals.
 */
class ProactiveMultiSignalController extends BaseController {
  constructor(opts) {
    super(opts);
    this.name = 'proactive';
    this.horizonS = opts.horizonS ?? 30;
    // Trigger thresholds intentionally match the reactive baselines (Tuned HPA /
    // HPA+VPA) so the only structural advantage is *when* the signal is
    // evaluated (forecast vs. current) and that multiple signals are fused —
    // not a looser scaling target.
    this.sloP99Trigger = 250;
    this.cpuTarget = 60;
    this.ramTarget = 75;
    this.poolTarget = 85;
    this.stabDownWindowS = 120;
    this.cooldownS = 15;
    this.maxStepUp = 2.0;
    this.maxStepDown = 0.5;

    // Each signal is tracked by an adaptive combination of Holt's
    // damped-trend forecaster and naive persistence (see forecaster.js:
    // CombinedForecaster), inverse-error-weighted online per signal. This
    // is a deliberate upgrade over using Holt alone: for signals where
    // trend extrapolation *hurts* relative to "near future looks like now"
    // (p99 latency, connection-pool utilization -- see Section VII-E), the
    // blend adaptively shifts weight toward persistence instead of paying
    // that cost, without ever requiring an offline training phase.
    // Damping factor: calibrated to phi=0.97 (uniformly across signals) by
    // runSensitivity.js's phi sweep, which showed the originally hand-picked
    // 0.85/0.9 leaves significant, non-cost accuracy on the table -- phi=0.97
    // significantly reduces SLO violation duration relative to both the
    // original phi and the Reactive Multi-Signal baseline, confirmed on a
    // disjoint set of held-out seeds never used to select it (see paper,
    // Section VII-G / results/sensitivity.json). opts.phiOverride lets the
    // sensitivity harness itself sweep this value without duplicating the
    // constructor.
    const CALIBRATED_PHI = 0.97;
    const phi = () => opts.phiOverride ?? CALIBRATED_PHI;
    this.f = {
      p99: new CombinedForecaster({ holtOpts: { alpha: 0.35, beta: 0.15, phi: phi() } }),
      cpu: new CombinedForecaster({ holtOpts: { alpha: 0.3, beta: 0.1, phi: phi() } }),
      ram: new CombinedForecaster({ holtOpts: { alpha: 0.4, beta: 0.2, phi: phi() } }),
      pool: new CombinedForecaster({ holtOpts: { alpha: 0.35, beta: 0.15, phi: phi() } }),
      backlog: new CombinedForecaster({ holtOpts: { alpha: 0.5, beta: 0.3, phi: phi() } }),
    };
    // Log of forecasts made, for later accuracy evaluation against ground truth.
    this.predictionLog = [];
  }

  /** Called every base simulation tick (not just control ticks) to keep forecasters warm. */
  observe(t, snapshot) {
    const stepsAhead = this.horizonS; // 1s ticks
    this.f.p99.update(snapshot.p99, stepsAhead);
    this.f.cpu.update(snapshot.cpu, stepsAhead);
    this.f.ram.update(snapshot.ram, stepsAhead);
    this.f.pool.update(snapshot.connPoolUtil, stepsAhead);
    this.f.backlog.update(snapshot.backlog, stepsAhead);

    const cp99 = this.f.p99.components(stepsAhead);
    const ccpu = this.f.cpu.components(stepsAhead);
    const cram = this.f.ram.components(stepsAhead);
    const cpool = this.f.pool.components(stepsAhead);
    const cbacklog = this.f.backlog.components(stepsAhead);
    this.predictionLog.push({
      madeAt: t,
      targetAt: t + this.horizonS,
      // top-level fields are the *blended* forecast actually used for decisions
      // (kept flat for backward-compatible reads by metrics.forecastAccuracy).
      p99: cp99.blended,
      cpu: ccpu.blended,
      ram: cram.blended,
      pool: cpool.blended,
      backlog: Math.max(0, cbacklog.blended),
      // per-model components, for the Holt-only / persistence-only ablation.
      components: {
        p99: cp99, cpu: ccpu, ram: cram, pool: cpool,
        backlog: { ...cbacklog, holt: Math.max(0, cbacklog.holt), persistence: Math.max(0, cbacklog.persistence), blended: Math.max(0, cbacklog.blended) },
      },
    });
  }

  decide(t, snapshot) {
    const horizon = this.horizonS;
    const predP99 = Math.max(0, this.f.p99.forecast(horizon));
    const predCpu = Math.max(0, this.f.cpu.forecast(horizon));
    const predRam = Math.max(0, this.f.ram.forecast(horizon));
    const predPool = Math.max(0, this.f.pool.forecast(horizon));
    const predBacklog = Math.max(0, this.f.backlog.forecast(horizon));

    // SLO-driven demand estimation: risk ratio per signal (>1 = predicted breach)
    const riskP99 = predP99 / this.sloP99Trigger;
    const riskCpu = predCpu / this.cpuTarget;
    const riskRam = predRam / this.ramTarget;
    const riskPool = predPool / this.poolTarget;
    const risk = Math.max(riskP99, riskCpu, riskRam, riskPool);
    const desiredFromRisk = snapshot.replicas * risk;

    // Workload-sensitivity adjustment: backlog drainage is a capacity *addition*,
    // not a multiplicative risk (its units are requests, not a utilization ratio).
    // Add enough replicas to drain the predicted backlog within drainTargetS.
    const drainTargetS = 30;
    const perReplicaCapacity = 50;
    const backlogReplicas = predBacklog / (drainTargetS * perReplicaCapacity);
    const backlogRisk = backlogReplicas > 0 ? (snapshot.replicas + backlogReplicas) / snapshot.replicas : 1;
    const rawDesired = desiredFromRisk + backlogReplicas;

    // Cost-aware guardrail: only accept scale-down if predicted risk is comfortably
    // below target for a full stabilization window (favors min-cost replica count
    // that still satisfies the predicted SLO/cost envelope).
    let desired = this._recordAndStabilizeDown(t, rawDesired, this.stabDownWindowS);

    // Stability: bounded step size + cooldown between actions
    const maxUp = this.lastReplicas * this.maxStepUp;
    const maxDown = this.lastReplicas * this.maxStepDown;
    desired = Math.min(desired, maxUp);
    desired = Math.max(desired, maxDown);

    if (desired !== this.lastReplicas && t - this.lastActionT < this.cooldownS) {
      desired = this.lastReplicas; // cooldown: hold previous target
    }
    desired = clampReplicas(desired);
    if (desired !== this.lastReplicas) this.lastActionT = t;
    this.lastReplicas = desired;

    return {
      desiredReplicas: desired,
      meta: {
        trigger: 'proactive-forecast',
        risk, riskP99, riskCpu, riskRam, riskPool, backlogRisk,
        predP99, predCpu, predRam, predPool, predBacklog,
        horizonS: horizon,
      },
    };
  }
}

module.exports = {
  MIN_REPLICAS,
  MAX_REPLICAS,
  SLO_P99_MS,
  DefaultHPAController,
  TunedHPAController,
  HpaVpaController,
  ReactiveMultiSignalController,
  ProactiveMultiSignalController,
};
