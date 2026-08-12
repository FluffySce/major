'use strict';
/**
 * Lightweight forecasting used by the proactive controller.
 *
 * HoltLinearForecaster implements Holt's double exponential smoothing
 * (level + trend), which is the "lightweight demand forecasting" referenced
 * as a design goal: O(1) update per tick, no training phase, robust to
 * noisy telemetry.
 *
 * PersistenceForecaster ("naive": predicted(t+H) = observed(t)) is kept as
 * a baseline to quantify how much forecasting skill Holt's method adds —
 * used later for the forecast-accuracy comparison table.
 */

class HoltLinearForecaster {
  /**
   * Damped-trend variant (Gardner & McKenzie, 1985): the trend's
   * contribution decays geometrically with `phi` per step, so long-horizon
   * forecasts converge instead of extrapolating linearly forever. This
   * keeps proactive scale-out bounded even when a sudden burst produces a
   * transient, very steep trend estimate.
   */
  constructor({ alpha = 0.5, beta = 0.3, phi = 0.9 } = {}) {
    this.alpha = alpha;
    this.beta = beta;
    this.phi = phi;
    this.level = null;
    this.trend = 0;
  }

  update(value) {
    if (this.level === null) {
      this.level = value;
      this.trend = 0;
      return;
    }
    const prevLevel = this.level;
    this.level = this.alpha * value + (1 - this.alpha) * (this.level + this.phi * this.trend);
    this.trend = this.beta * (this.level - prevLevel) + (1 - this.beta) * this.phi * this.trend;
  }

  /** Predict value `stepsAhead` ticks into the future, with damped trend. */
  forecast(stepsAhead) {
    if (this.level === null) return 0;
    // sum_{i=1..h} phi^i = phi*(1-phi^h)/(1-phi)
    const phi = this.phi;
    const dampedSum = Math.abs(1 - phi) < 1e-9 ? stepsAhead : (phi * (1 - phi ** stepsAhead)) / (1 - phi);
    return this.level + this.trend * dampedSum;
  }
}

class PersistenceForecaster {
  constructor() {
    this.last = null;
  }
  update(value) {
    this.last = value;
  }
  forecast() {
    return this.last ?? 0;
  }
}

/**
 * Simple moving-average forecaster: predicted(t+h) = mean of the last
 * `window` observed values. A classical, training-free baseline that
 * smooths noise more aggressively than persistence but (unlike Holt) does
 * not extrapolate any trend at all.
 */
class SimpleMovingAverageForecaster {
  constructor({ window = 20 } = {}) {
    this.window = window;
    this.buf = [];
  }
  update(value) {
    this.buf.push(value);
    if (this.buf.length > this.window) this.buf.shift();
  }
  forecast() {
    if (!this.buf.length) return 0;
    return this.buf.reduce((a, b) => a + b, 0) / this.buf.length;
  }
}

/**
 * Linear-drift ("naive drift") forecaster: fits a straight line through the
 * last `window` observations by simple two-point drift (last - first) / span
 * and extrapolates it `stepsAhead` ticks forward. A classical baseline for
 * "is there a trend at all", cheaper than Holt (no smoothing parameters) but
 * with no damping, so it can overshoot on short-lived spikes.
 */
class LinearDriftForecaster {
  constructor({ window = 20 } = {}) {
    this.window = window;
    this.buf = [];
  }
  update(value) {
    this.buf.push(value);
    if (this.buf.length > this.window) this.buf.shift();
  }
  forecast(stepsAhead) {
    if (!this.buf.length) return 0;
    if (this.buf.length === 1) return this.buf[0];
    const first = this.buf[0];
    const last = this.buf[this.buf.length - 1];
    const span = this.buf.length - 1;
    const slope = (last - first) / span;
    return last + slope * stepsAhead;
  }
}

/**
 * Adaptive combination forecaster (Bates & Granger, 1969): blends a
 * damped-trend Holt forecast with a naive persistence forecast, weighting
 * each inversely to its own recent forecasting error. This directly targets
 * the failure mode where Holt's trend extrapolation helps on smooth signals
 * (RAM) but *hurts* on heavy-tailed, fast-transient signals (p99 latency,
 * connection-pool utilization) where "the near future looks like now" is
 * actually the better model: instead of committing to one model per signal
 * ahead of time, the weight is learned online, per signal, at no extra
 * training cost and O(1) per tick -- preserving the training-free,
 * explainable design goal the paper argues for.
 */
class CombinedForecaster {
  constructor({ holtOpts = {}, errorHalfLifeS = 120 } = {}) {
    this.holt = new HoltLinearForecaster(holtOpts);
    this.persistence = new PersistenceForecaster();
    // EWMA decay chosen so error tracking has ~errorHalfLifeS half-life.
    this.errDecay = Math.pow(0.5, 1 / Math.max(1, errorHalfLifeS));
    this.holtErrEwma = null;
    this.persErrEwma = null;
    this.tick = 0;
    this.pending = []; // {targetTick, holt, pers}, forecasts still awaiting their ground truth
  }

  /**
   * Call once per tick with the newly observed value. `stepsAhead` (ticks)
   * is the horizon this forecaster is used for. Internally keeps a small
   * FIFO of past forecasts and, once `stepsAhead` ticks have actually
   * elapsed, scores each model's forecast against the now-realized actual --
   * this is the only correct way to adapt the blend weight online without
   * peeking at the future.
   */
  update(value, stepsAhead) {
    this.tick += 1;
    if (this.pending.length) {
      while (this.pending.length && this.pending[0].targetTick < this.tick) this.pending.shift();
      if (this.pending.length && this.pending[0].targetTick === this.tick) {
        const due = this.pending.shift();
        const eHolt = Math.abs(due.holt - value);
        const ePers = Math.abs(due.pers - value);
        this.holtErrEwma = this.holtErrEwma === null ? eHolt : this.errDecay * this.holtErrEwma + (1 - this.errDecay) * eHolt;
        this.persErrEwma = this.persErrEwma === null ? ePers : this.errDecay * this.persErrEwma + (1 - this.errDecay) * ePers;
      }
    }
    this.holt.update(value);
    this.persistence.update(value);
    if (stepsAhead) {
      this.pending.push({
        targetTick: this.tick + stepsAhead,
        holt: this.holt.forecast(stepsAhead),
        pers: this.persistence.forecast(stepsAhead),
      });
    }
  }

  /** Inverse-error blend weight for Holt, in [0.05, 0.95] (never fully zero out either model). */
  weightHolt() {
    if (this.holtErrEwma === null || this.persErrEwma === null) return 0.5;
    const hInv = 1 / Math.max(this.holtErrEwma, 1e-6);
    const pInv = 1 / Math.max(this.persErrEwma, 1e-6);
    const w = hInv / (hInv + pInv);
    return Math.min(0.95, Math.max(0.05, w));
  }

  /** Returns { holt, persistence, blended, weightHolt } for stepsAhead ticks ahead. */
  components(stepsAhead) {
    const holt = this.holt.forecast(stepsAhead);
    const persistence = this.persistence.forecast(stepsAhead);
    const w = this.weightHolt();
    return { holt, persistence, blended: w * holt + (1 - w) * persistence, weightHolt: w };
  }

  forecast(stepsAhead) {
    return this.components(stepsAhead).blended;
  }
}

module.exports = {
  HoltLinearForecaster,
  PersistenceForecaster,
  SimpleMovingAverageForecaster,
  LinearDriftForecaster,
  CombinedForecaster,
};
