'use strict';
/**
 * Evaluation metrics computed from a simulation run's timeseries.
 * Mirrors the paper's four metric categories (SLO adherence, scaling
 * responsiveness, cost efficiency, stability) and adds forecast-accuracy /
 * classification metrics for the proactive controller's predictions.
 */
const { PER_REPLICA_CAPACITY, SLOTS_PER_NODE } = require('./systemModel');
const { SLO_P99_MS } = require('./controllers');

function sloViolations(timeseries, sloP99 = SLO_P99_MS) {
  let count = 0;
  let duration = 0;
  let inViolation = false;
  for (const s of timeseries) {
    if (s.p99 > sloP99) {
      duration += 1;
      if (!inViolation) { count += 1; inViolation = true; }
    } else {
      inViolation = false;
    }
  }
  return { count, durationSeconds: duration };
}

function costEfficiency(timeseries) {
  const avgReplicas = mean(timeseries.map((s) => s.replicas));
  const nodeSeconds = timeseries.reduce((acc, s) => acc + s.nodesProvisioned, 0);
  const nodeHours = nodeSeconds / 3600;
  const avgNodes = mean(timeseries.map((s) => s.nodesProvisioned));
  return { avgReplicas, nodeHours, avgNodes };
}

function stability(timeseries) {
  const actions = timeseries.filter((s) => s.action);
  let churn = 0;
  let oscillations = 0;
  let prevReplicas = actions.length ? actions[0].desiredReplicas : 0;
  let prevDelta = 0;
  for (let i = 1; i < actions.length; i++) {
    const delta = actions[i].desiredReplicas - prevReplicas;
    if (delta !== 0) {
      churn += 1;
      if (prevDelta !== 0 && Math.sign(delta) !== Math.sign(prevDelta)) oscillations += 1;
      prevDelta = delta;
    }
    prevReplicas = actions[i].desiredReplicas;
  }
  const durationHours = timeseries.length / 3600;
  return {
    churnEvents: churn,
    churnPerHour: churn / durationHours,
    oscillations,
    oscillationsPerHour: oscillations / durationHours,
    pendingUnschedulableSeconds: timeseries.reduce((a, s) => a + (s.pendingUnschedulable > 0 ? 1 : 0), 0),
  };
}

/** Detect demand upshift events and measure time until replica capacity catches up. */
function timeToScale(timeseries, targetUtil = 0.7) {
  const window = 120;
  const baseline = [];
  const events = [];
  let inEvent = false;
  let eventStart = null;
  for (let i = 0; i < timeseries.length; i++) {
    const recentStart = Math.max(0, i - window);
    const recent = timeseries.slice(recentStart, i).map((s) => s.demandRps);
    const base = recent.length ? mean(recent) : timeseries[i].demandRps;
    baseline.push(base);
    const isSpike = timeseries[i].demandRps > base * 1.5 && base > 0;
    if (isSpike && !inEvent) {
      inEvent = true;
      eventStart = i;
    } else if (!isSpike && inEvent && timeseries[i].demandRps < base * 1.2) {
      inEvent = false;
      events.push({ start: eventStart, end: i });
    }
  }
  const delays = [];
  for (const ev of events) {
    const peakWindowEnd = Math.min(timeseries.length - 1, ev.start + window);
    const peak = Math.max(...timeseries.slice(ev.start, peakWindowEnd + 1).map((s) => s.demandRps));
    const needed = Math.ceil(peak / (PER_REPLICA_CAPACITY * targetUtil));
    let delay = 300; // penalize if never reached within search horizon
    const searchEnd = Math.min(timeseries.length - 1, ev.start + 300);
    for (let j = ev.start; j <= searchEnd; j++) {
      if (timeseries[j].replicas >= needed * 0.9) {
        delay = timeseries[j].t - timeseries[ev.start].t;
        break;
      }
    }
    delays.push(delay);
  }
  return {
    events: events.length,
    avgTimeToScaleSeconds: delays.length ? mean(delays) : null,
    p90TimeToScaleSeconds: delays.length ? percentile(delays, 90) : null,
  };
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Forecast accuracy for a prediction log against realized ground truth.
 * `variant` selects which model's forecast to score: null/undefined (the
 * flat, top-level field -- whatever the controller actually used to decide,
 * e.g. the adaptive blend) or 'holt'/'persistence' to read the
 * corresponding per-model component logged alongside it, for ablation.
 */
function forecastAccuracy(predictionLog, timeseries, signalKey, variant = null) {
  const byT = new Map(timeseries.map((s) => [s.t, s]));
  const errors = [];
  const pairs = [];
  for (const p of predictionLog) {
    const actualSnap = byT.get(p.targetAt);
    if (!actualSnap) continue;
    const predicted = variant && p.components ? p.components[signalKey][variant] : p[signalKey];
    const actual = actualSnap[signalKey === 'pool' ? 'connPoolUtil' : signalKey];
    errors.push({ predicted, actual, err: predicted - actual });
    pairs.push([predicted, actual]);
  }
  return summarizeErrors(errors, pairs);
}

/** Baseline "naive" forecast: predicted(t+H) = actual(t). Computed directly from timeseries. */
function persistenceForecastAccuracy(timeseries, signalKey, horizonS) {
  const errors = [];
  const pairs = [];
  const key = signalKey === 'pool' ? 'connPoolUtil' : signalKey;
  for (let i = 0; i + horizonS < timeseries.length; i++) {
    const predicted = timeseries[i][key];
    const actual = timeseries[i + horizonS][key];
    errors.push({ predicted, actual, err: predicted - actual });
    pairs.push([predicted, actual]);
  }
  return summarizeErrors(errors, pairs);
}

/**
 * Forecast accuracy for a classical baseline forecaster (e.g. simple moving
 * average, linear drift) that isn't part of any controller's own decision
 * loop: replay it causally over an already-simulated timeseries (any
 * forecaster with `.update(value)` / `.forecast(stepsAhead)`).
 */
function classicalForecastAccuracy(timeseries, signalKey, horizonS, makeForecaster) {
  const key = signalKey === 'pool' ? 'connPoolUtil' : signalKey;
  const forecaster = makeForecaster();
  const errors = [];
  const pairs = [];
  const pending = [];
  for (let i = 0; i < timeseries.length; i++) {
    const actual = timeseries[i][key];
    while (pending.length && pending[0].targetIdx === i) {
      const due = pending.shift();
      errors.push({ predicted: due.predicted, actual, err: due.predicted - actual });
      pairs.push([due.predicted, actual]);
    }
    forecaster.update(actual);
    const predicted = forecaster.forecast(horizonS);
    if (i + horizonS < timeseries.length) pending.push({ targetIdx: i + horizonS, predicted });
  }
  return summarizeErrors(errors, pairs);
}

function summarizeErrors(errors, pairs) {
  if (!errors.length) return null;
  const n = errors.length;
  const mae = mean(errors.map((e) => Math.abs(e.err)));
  const rmse = Math.sqrt(mean(errors.map((e) => e.err * e.err)));
  // Plain MAPE is undefined/explosive when `actual` is near zero (both p99
  // during calm periods and connPoolUtil can sit near 0). Use symmetric MAPE
  // (bounded in [0,200]) as the basis for a bounded, interpretable
  // "accuracy %" instead.
  const smape = mean(errors.map((e) => {
    const denom = (Math.abs(e.predicted) + Math.abs(e.actual)) / 2;
    return denom > 1e-9 ? Math.abs(e.err) / denom : 0;
  })) * 100;
  const mape = mean(errors.map((e) => Math.abs(e.err) / Math.max(Math.abs(e.actual), 1e-6))) * 100;
  const accuracyPct = Math.max(0, 100 - smape / 2);
  const actualMean = mean(pairs.map((p) => p[1]));
  const ssTot = pairs.reduce((acc, p) => acc + (p[1] - actualMean) ** 2, 0);
  const ssRes = pairs.reduce((acc, p) => acc + (p[0] - p[1]) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
  return { n, mae, rmse, mape, smape, accuracyPct, r2 };
}

/** Binary "will SLO be breached" classification quality of the forecaster. */
function overloadClassification(predictionLog, timeseries, sloP99 = SLO_P99_MS) {
  const byT = new Map(timeseries.map((s) => [s.t, s]));
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const p of predictionLog) {
    const actualSnap = byT.get(p.targetAt);
    if (!actualSnap) continue;
    const predictedOverload = p.p99 > sloP99;
    const actualOverload = actualSnap.p99 > sloP99;
    if (predictedOverload && actualOverload) tp += 1;
    else if (predictedOverload && !actualOverload) fp += 1;
    else if (!predictedOverload && actualOverload) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall) : null;
  const accuracy = (tp + tn) / Math.max(1, tp + fp + fn + tn);
  return { tp, fp, fn, tn, precision, recall, f1, accuracy };
}

function persistenceOverloadClassification(timeseries, horizonS, sloP99 = SLO_P99_MS) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i + horizonS < timeseries.length; i++) {
    const predictedOverload = timeseries[i].p99 > sloP99;
    const actualOverload = timeseries[i + horizonS].p99 > sloP99;
    if (predictedOverload && actualOverload) tp += 1;
    else if (predictedOverload && !actualOverload) fp += 1;
    else if (!predictedOverload && actualOverload) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall) : null;
  const accuracy = (tp + tn) / Math.max(1, tp + fp + fn + tn);
  return { tp, fp, fn, tn, precision, recall, f1, accuracy };
}

/**
 * Windowed overload classification: "did the forecaster give advance
 * warning, made at time t for t+h, of an SLO breach that in fact occurs at
 * *some* point in (t, t+h]?" This is the operationally meaningful framing
 * (a controller wants to know whether to act now because overload is
 * coming within the horizon, not whether latency crosses the line at the
 * exact instant t+h) and is less punishing of small timing offsets than the
 * point-in-time definition in `overloadClassification`, which is kept for
 * comparison. `scoreKey` selects which per-tick prediction field represents
 * predicted risk (default the flat/blended p99 forecast used for decisions).
 */
function overloadClassificationWindowed(predictionLog, timeseries, horizonS, sloP99 = SLO_P99_MS, scoreKey = 'p99') {
  const byT = new Map(timeseries.map((s) => [s.t, s]));
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const p of predictionLog) {
    const predictedOverload = p[scoreKey] > sloP99;
    let actualOverload = false;
    for (let dt = 1; dt <= horizonS; dt++) {
      const snap = byT.get(p.madeAt + dt);
      if (snap && snap.p99 > sloP99) { actualOverload = true; break; }
    }
    if (predictedOverload && actualOverload) tp += 1;
    else if (predictedOverload && !actualOverload) fp += 1;
    else if (!predictedOverload && actualOverload) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall) : null;
  const accuracy = (tp + tn) / Math.max(1, tp + fp + fn + tn);
  return { tp, fp, fn, tn, precision, recall, f1, accuracy };
}

function persistenceOverloadClassificationWindowed(timeseries, horizonS, sloP99 = SLO_P99_MS) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i + horizonS < timeseries.length; i++) {
    const predictedOverload = timeseries[i].p99 > sloP99;
    let actualOverload = false;
    for (let dt = 1; dt <= horizonS; dt++) {
      if (timeseries[i + dt] && timeseries[i + dt].p99 > sloP99) { actualOverload = true; break; }
    }
    if (predictedOverload && actualOverload) tp += 1;
    else if (predictedOverload && !actualOverload) fp += 1;
    else if (!predictedOverload && actualOverload) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall) : null;
  const accuracy = (tp + tn) / Math.max(1, tp + fp + fn + tn);
  return { tp, fp, fn, tn, precision, recall, f1, accuracy };
}

/**
 * Precision/recall sweep over the decision threshold itself (rather than
 * the fixed SLO value), using the windowed ground-truth definition above.
 * Reports the best-F1 operating point and the PR-AUC (trapezoidal), so the
 * single-threshold precision/recall numbers can be judged against the
 * model's discriminative power at its best operating point, not just at
 * the threshold that happens to equal the SLO target.
 */
function classificationThresholdSweep(predictionLog, timeseries, horizonS, scoreKey = 'p99') {
  const byT = new Map(timeseries.map((s) => [s.t, s]));
  const scored = [];
  for (const p of predictionLog) {
    let actualOverload = false;
    for (let dt = 1; dt <= horizonS; dt++) {
      const snap = byT.get(p.madeAt + dt);
      if (snap && snap.p99 > SLO_P99_MS) { actualOverload = true; break; }
    }
    scored.push({ score: p[scoreKey], actual: actualOverload });
  }
  if (!scored.length) return null;
  const thresholds = [...new Set(scored.map((s) => s.score))].sort((a, b) => a - b);
  const points = [];
  for (const th of thresholds) {
    let tp = 0, fp = 0, fn = 0;
    for (const s of scored) {
      const pred = s.score > th;
      if (pred && s.actual) tp += 1;
      else if (pred && !s.actual) fp += 1;
      else if (!pred && s.actual) fn += 1;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    points.push({ threshold: th, precision, recall, f1 });
  }
  const best = points.reduce((a, b) => (b.f1 > a.f1 ? b : a), points[0]);
  // PR-AUC via trapezoidal integration over recall, sorted ascending by recall.
  const sortedByRecall = [...points].sort((a, b) => a.recall - b.recall);
  let prAuc = 0;
  for (let i = 1; i < sortedByRecall.length; i++) {
    const dR = sortedByRecall[i].recall - sortedByRecall[i - 1].recall;
    prAuc += dR * (sortedByRecall[i].precision + sortedByRecall[i - 1].precision) / 2;
  }
  return { bestF1: best, prAuc, nThresholds: thresholds.length };
}

/** Sample mean, population std, standard error of the mean, and a normal-approx 95% CI. */
function summarizeSamples(arr) {
  const vals = arr.filter((v) => v != null && Number.isFinite(v));
  const n = vals.length;
  if (!n) return { n: 0, mean: null, std: null, sem: null, ci95: [null, null] };
  const m = mean(vals);
  const variance = n > 1 ? vals.reduce((acc, v) => acc + (v - m) ** 2, 0) / (n - 1) : 0;
  const std = Math.sqrt(variance);
  const sem = std / Math.sqrt(n);
  return { n, mean: m, std, sem, ci95: [m - 1.96 * sem, m + 1.96 * sem] };
}

/**
 * Paired two-tailed t-test on (sampleA - sampleB), e.g. per-(pattern,seed)
 * SLO-violation durations for two controllers run against identical demand.
 * Pairing removes cross-run variance (the demand trace itself) so the test
 * isolates the controller's effect. p-value uses the regularized incomplete
 * beta function (Numerical Recipes `betai`), implemented from scratch since
 * no stats dependency is otherwise needed in this project.
 */
function pairedTTest(sampleA, sampleB) {
  const n = Math.min(sampleA.length, sampleB.length);
  const diffs = [];
  for (let i = 0; i < n; i++) {
    if (sampleA[i] != null && sampleB[i] != null) diffs.push(sampleA[i] - sampleB[i]);
  }
  const m = diffs.length;
  if (m < 2) return { n: m, meanDiff: null, t: null, df: null, p: null };
  const meanDiff = mean(diffs);
  const variance = diffs.reduce((acc, d) => acc + (d - meanDiff) ** 2, 0) / (m - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(m);
  const df = m - 1;
  if (se === 0) return { n: m, meanDiff, t: meanDiff === 0 ? 0 : Infinity, df, p: meanDiff === 0 ? 1 : 0 };
  const t = meanDiff / se;
  const p = studentTTwoTailedP(t, df);
  return { n: m, meanDiff, t, df, p };
}

function studentTTwoTailedP(t, df) {
  const x = df / (df + t * t);
  return betacf_incompleteBeta(x, df / 2, 0.5);
}

// Regularized incomplete beta function I_x(a,b), via continued fraction
// (Numerical Recipes 6.4). Used only to get a p-value for the paired t-test
// above without pulling in a stats library.
function betacf_incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lbeta);
  const useFront = x < (a + 1) / (a + b + 2);
  const cf = betacfContinuedFraction(useFront ? x : 1 - x, useFront ? a : b, useFront ? b : a);
  const result = (front * cf) / (useFront ? a : b);
  return useFront ? result : 1 - result;
}

function betacfContinuedFraction(x, a, b) {
  const MAXIT = 200, EPS = 3e-9, FPMIN = 1e-30;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function logGamma(x) {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += cof[j] / y; }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

module.exports = {
  sloViolations,
  costEfficiency,
  stability,
  timeToScale,
  forecastAccuracy,
  persistenceForecastAccuracy,
  classicalForecastAccuracy,
  overloadClassification,
  persistenceOverloadClassification,
  overloadClassificationWindowed,
  persistenceOverloadClassificationWindowed,
  classificationThresholdSweep,
  summarizeSamples,
  pairedTTest,
  mean,
  percentile,
};
