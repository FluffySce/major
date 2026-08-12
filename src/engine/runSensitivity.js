'use strict';
/**
 * Sensitivity analysis and hyperparameter calibration.
 *
 * Sweeps the two hyperparameters the original evaluation held fixed
 * (forecast horizon h and damping factor phi) across all workload patterns,
 * using only TUNE_SEEDS, and reports both the forecasting layer's own
 * accuracy and the end-to-end SLO/cost effect at each setting, together
 * with a paired significance test against the Reactive Multi-Signal
 * baseline (same signals, no forecast). The phi value selected from the
 * tuning sweep is then re-validated on the disjoint HOLDOUT_SEEDS, so the
 * final reported improvement is not measured on the same data used to pick
 * the hyperparameter. Writes results/sensitivity.json.
 */
const fs = require('fs');
const path = require('path');
const { runSimulation } = require('./simulate');
const { ReactiveMultiSignalController, ProactiveMultiSignalController } = require('./controllers');
const { sloViolations, costEfficiency, forecastAccuracy, summarizeSamples, pairedTTest, mean } = require('./metrics');
const { TUNE_SEEDS, HOLDOUT_SEEDS, SEED: CANONICAL_SEED } = require('../data/generateDummyData');

const OUT_FILE = path.join(__dirname, '..', '..', 'results', 'sensitivity.json');
const RAW_DIR = path.join(__dirname, '..', '..', 'results', 'raw');
const PATTERNS = ['bursty', 'queue_driven', 'mixed'];
const HORIZONS = [15, 30, 45, 60, 75, 90, 120];
const PHIS = [0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.97, 0.99];
const DEFAULT_HORIZON = 45;
// This script always passes an explicit phiOverride -- never relies on
// ProactiveMultiSignalController's own default -- so its results stay
// reproducible regardless of what that default is currently set to (it was
// changed, below, as a *result* of this analysis).
const ORIGINAL_PHI = 0.85; // representative hand-picked value predating this sweep (was 0.85-0.9 per signal)
// Selected from the tuning sweep below: clearly better than the original
// hand-picked 0.85-0.9 (see phiSweep) while stopping short of the least-damped
// end of the grid (0.99) to avoid selecting the literal grid boundary /
// overfitting to five seeds -- see Section VII of the paper.
const CALIBRATED_PHI = 0.97;

function loadDemand(pattern, seed) {
  const file = seed === CANONICAL_SEED
    ? path.join(RAW_DIR, `${pattern}.json`)
    : path.join(RAW_DIR, `${pattern}__seed${seed}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runProactive(pattern, seed, horizonS, phiOverride) {
  const demand = loadDemand(pattern, seed);
  const opts = { horizonS, seed };
  if (phiOverride != null) opts.phiOverride = phiOverride;
  const result = runSimulation(demand, ProactiveMultiSignalController, opts);
  const ts = result.timeseries;
  return {
    slo: sloViolations(ts), cost: costEfficiency(ts),
    p99Accuracy: result.predictionLog ? forecastAccuracy(result.predictionLog, ts, 'p99').accuracyPct : null,
  };
}

function runReactiveMS(pattern, seed) {
  const demand = loadDemand(pattern, seed);
  const result = runSimulation(demand, ReactiveMultiSignalController, { seed });
  const ts = result.timeseries;
  return { slo: sloViolations(ts), cost: costEfficiency(ts) };
}

function reactiveBaseline(seeds) {
  const rows = [];
  for (const pattern of PATTERNS) {
    for (const seed of seeds) rows.push({ pattern, seed, ...runReactiveMS(pattern, seed) });
  }
  return rows;
}

function pairedVsReactive(rows, reactiveRows) {
  const a = [], b = [];
  for (const r of rows) {
    const match = reactiveRows.find((x) => x.pattern === r.pattern && x.seed === r.seed);
    a.push(r.slo.durationSeconds);
    b.push(match.slo.durationSeconds);
  }
  return pairedTTest(a, b);
}

function main() {
  const reactiveTune = reactiveBaseline(TUNE_SEEDS);

  const horizonSweep = HORIZONS.map((h) => {
    const rows = [];
    for (const pattern of PATTERNS) {
      for (const seed of TUNE_SEEDS) rows.push({ pattern, seed, ...runProactive(pattern, seed, h, ORIGINAL_PHI) });
    }
    return {
      horizonS: h,
      sloDuration: summarizeSamples(rows.map((r) => r.slo.durationSeconds)),
      nodeHours: summarizeSamples(rows.map((r) => r.cost.nodeHours)),
      p99ForecastAccuracyPct: mean(rows.map((r) => r.p99Accuracy).filter((v) => v != null)),
      vsReactiveMultiSignal: pairedVsReactive(rows, reactiveTune),
    };
  });

  const phiSweep = PHIS.map((phi) => {
    const rows = [];
    for (const pattern of PATTERNS) {
      for (const seed of TUNE_SEEDS) rows.push({ pattern, seed, ...runProactive(pattern, seed, DEFAULT_HORIZON, phi) });
    }
    return {
      phi,
      sloDuration: summarizeSamples(rows.map((r) => r.slo.durationSeconds)),
      nodeHours: summarizeSamples(rows.map((r) => r.cost.nodeHours)),
      p99ForecastAccuracyPct: mean(rows.map((r) => r.p99Accuracy).filter((v) => v != null)),
      vsReactiveMultiSignal: pairedVsReactive(rows, reactiveTune),
    };
  });

  // ---- Held-out validation of the calibrated phi, on seeds never used for tuning ----
  const reactiveHoldout = reactiveBaseline(HOLDOUT_SEEDS);
  const holdoutRowsDefault = [];
  const holdoutRowsCalibrated = [];
  for (const pattern of PATTERNS) {
    for (const seed of HOLDOUT_SEEDS) {
      holdoutRowsDefault.push({ pattern, seed, ...runProactive(pattern, seed, DEFAULT_HORIZON, ORIGINAL_PHI) });
      holdoutRowsCalibrated.push({ pattern, seed, ...runProactive(pattern, seed, DEFAULT_HORIZON, CALIBRATED_PHI) });
    }
  }
  const holdoutValidation = {
    seeds: HOLDOUT_SEEDS,
    calibratedPhi: CALIBRATED_PHI,
    reactiveMultiSignal: summarizeSamples(reactiveHoldout.map((r) => r.slo.durationSeconds)),
    proactiveOriginalPhi: summarizeSamples(holdoutRowsDefault.map((r) => r.slo.durationSeconds)),
    proactiveCalibratedPhi: summarizeSamples(holdoutRowsCalibrated.map((r) => r.slo.durationSeconds)),
    calibratedVsReactive: pairedVsReactive(holdoutRowsCalibrated, reactiveHoldout),
    calibratedVsOriginalPhi: pairedTTest(
      holdoutRowsCalibrated.map((r) => r.slo.durationSeconds),
      holdoutRowsDefault.map((r) => r.slo.durationSeconds),
    ),
  };

  const out = {
    generatedAt: new Date().toISOString(),
    tuneSeeds: TUNE_SEEDS,
    holdoutSeeds: HOLDOUT_SEEDS,
    patterns: PATTERNS,
    reactiveMultiSignalBaselineTune: summarizeSamples(reactiveTune.map((r) => r.slo.durationSeconds)),
    horizonSweep,
    phiSweep,
    holdoutValidation,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`wrote ${OUT_FILE}`);
  for (const row of horizonSweep) {
    console.log(`h=${row.horizonS}s: sloDur=${row.sloDuration.mean.toFixed(1)}+/-${row.sloDuration.std.toFixed(1)} p99Acc=${row.p99ForecastAccuracyPct.toFixed(1)}% vsReactiveMS p=${row.vsReactiveMultiSignal.p?.toFixed(4)} meanDiff=${row.vsReactiveMultiSignal.meanDiff?.toFixed(2)}`);
  }
  for (const row of phiSweep) {
    console.log(`phi=${row.phi}: sloDur=${row.sloDuration.mean.toFixed(1)}+/-${row.sloDuration.std.toFixed(1)} p99Acc=${row.p99ForecastAccuracyPct.toFixed(1)}% vsReactiveMS p=${row.vsReactiveMultiSignal.p?.toFixed(4)} meanDiff=${row.vsReactiveMultiSignal.meanDiff?.toFixed(2)}`);
  }
  console.log('\nHoldout validation (seeds never used for tuning):');
  console.log(`  Reactive-MS:        ${holdoutValidation.reactiveMultiSignal.mean.toFixed(1)} +/- ${holdoutValidation.reactiveMultiSignal.std.toFixed(1)}`);
  console.log(`  Proactive (orig):   ${holdoutValidation.proactiveOriginalPhi.mean.toFixed(1)} +/- ${holdoutValidation.proactiveOriginalPhi.std.toFixed(1)}`);
  console.log(`  Proactive (phi=${CALIBRATED_PHI}): ${holdoutValidation.proactiveCalibratedPhi.mean.toFixed(1)} +/- ${holdoutValidation.proactiveCalibratedPhi.std.toFixed(1)}`);
  console.log(`  calibrated vs reactive: meanDiff=${holdoutValidation.calibratedVsReactive.meanDiff?.toFixed(2)} p=${holdoutValidation.calibratedVsReactive.p?.toFixed(4)}`);
  console.log(`  calibrated vs original phi: meanDiff=${holdoutValidation.calibratedVsOriginalPhi.meanDiff?.toFixed(2)} p=${holdoutValidation.calibratedVsOriginalPhi.p?.toFixed(4)}`);
}

if (require.main === module) main();
module.exports = { main, CALIBRATED_PHI };
