'use strict';
/**
 * Orchestrates the full evaluation: runs every controller against every
 * workload pattern (and, for statistical robustness, against multiple
 * independently-sampled demand-trace seeds per pattern), computes all
 * metrics, and writes:
 *   - results/timeseries/<pattern>__<controller>.json  (per-run detail, canonical seed only)
 *   - results/summary.json                              (aggregated tables, multi-seed stats, significance)
 */
const fs = require('fs');
const path = require('path');
const { runSimulation } = require('./simulate');
const {
  DefaultHPAController,
  TunedHPAController,
  HpaVpaController,
  ReactiveMultiSignalController,
  ProactiveMultiSignalController,
} = require('./controllers');
const { SimpleMovingAverageForecaster, LinearDriftForecaster } = require('./forecaster');
const {
  sloViolations, costEfficiency, stability, timeToScale,
  forecastAccuracy, persistenceForecastAccuracy, classicalForecastAccuracy,
  overloadClassification, persistenceOverloadClassification,
  overloadClassificationWindowed, persistenceOverloadClassificationWindowed,
  classificationThresholdSweep,
  summarizeSamples, pairedTTest,
  mean,
} = require('./metrics');
const { REPLICATE_SEEDS, SEED: CANONICAL_SEED } = require('../data/generateDummyData');

const RAW_DIR = path.join(__dirname, '..', '..', 'results', 'raw');
const TS_DIR = path.join(__dirname, '..', '..', 'results', 'timeseries');
const SUMMARY_FILE = path.join(__dirname, '..', '..', 'results', 'summary.json');

const PATTERNS = ['bursty', 'queue_driven', 'mixed'];
const CONTROLLERS = [
  { cls: DefaultHPAController, label: 'Default HPA' },
  { cls: TunedHPAController, label: 'Tuned HPA' },
  { cls: HpaVpaController, label: 'HPA + VPA (reactive multi-metric)' },
  { cls: ReactiveMultiSignalController, label: 'Reactive Multi-Signal (same signals, no forecast)' },
  { cls: ProactiveMultiSignalController, label: 'Proactive Multi-Signal (proposed)' },
];
const FORECAST_SIGNALS = ['p99', 'cpu', 'ram', 'pool'];
const HORIZON_S = 45;

function loadDemand(pattern, seed) {
  const file = seed === CANONICAL_SEED
    ? path.join(RAW_DIR, `${pattern}.json`)
    : path.join(RAW_DIR, `${pattern}__seed${seed}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function thin(timeseries, stride = 5) {
  // reduce payload size for the dashboard while keeping shape
  return timeseries.filter((_, i) => i % stride === 0);
}

function runOne(pattern, seed, cls, label) {
  const demand = loadDemand(pattern, seed);
  const result = runSimulation(demand, cls, { horizonS: HORIZON_S, seed });
  const ts = result.timeseries;
  const slo = sloViolations(ts);
  const cost = costEfficiency(ts);
  const stab = stability(ts);
  const t2s = timeToScale(ts);
  return {
    pattern, seed, controller: result.controller, label,
    controlIntervalS: result.controlIntervalS,
    metrics: { slo, cost, stability: stab, timeToScale: t2s },
    timeseries: ts,
    predictionLog: result.predictionLog,
  };
}

function main() {
  fs.mkdirSync(TS_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    horizonS: HORIZON_S,
    canonicalSeed: CANONICAL_SEED,
    replicateSeeds: REPLICATE_SEEDS,
    runs: [], // canonical-seed runs only (detailed metrics + forecast/classification analysis)
    multiSeedRuns: [], // lightweight metrics for every (pattern, seed, controller)
  };

  // ---- Canonical-seed detailed runs (drives forecast/classification analysis and figures) ----
  const canonicalByPC = {};
  for (const pattern of PATTERNS) {
    for (const { cls, label } of CONTROLLERS) {
      const run = runOne(pattern, CANONICAL_SEED, cls, label);
      canonicalByPC[`${pattern}__${run.controller}`] = run;

      let forecast = null;
      let classification = null;
      let classificationWindowed = null;
      let thresholdSweep = null;
      if (run.predictionLog) {
        forecast = {};
        for (const sig of FORECAST_SIGNALS) {
          forecast[sig] = {
            model: forecastAccuracy(run.predictionLog, run.timeseries, sig), // blended (used for decisions)
            holtOnly: forecastAccuracy(run.predictionLog, run.timeseries, sig, 'holt'),
            persistence: persistenceForecastAccuracy(run.timeseries, sig, HORIZON_S),
            movingAverage: classicalForecastAccuracy(run.timeseries, sig, HORIZON_S, () => new SimpleMovingAverageForecaster({ window: 20 })),
            linearDrift: classicalForecastAccuracy(run.timeseries, sig, HORIZON_S, () => new LinearDriftForecaster({ window: 20 })),
          };
        }
        classification = {
          model: overloadClassification(run.predictionLog, run.timeseries),
          persistence: persistenceOverloadClassification(run.timeseries, HORIZON_S),
        };
        classificationWindowed = {
          model: overloadClassificationWindowed(run.predictionLog, run.timeseries, HORIZON_S),
          persistence: persistenceOverloadClassificationWindowed(run.timeseries, HORIZON_S),
        };
        thresholdSweep = classificationThresholdSweep(run.predictionLog, run.timeseries, HORIZON_S);
      }

      const runRecord = {
        pattern, controller: run.controller, label,
        controlIntervalS: run.controlIntervalS,
        metrics: run.metrics,
        forecast, classification, classificationWindowed, thresholdSweep,
      };
      summary.runs.push(runRecord);

      const tsFile = path.join(TS_DIR, `${pattern}__${run.controller}.json`);
      fs.writeFileSync(tsFile, JSON.stringify({
        pattern, controller: run.controller, label,
        controlIntervalS: run.controlIntervalS,
        timeseries: thin(run.timeseries, 3),
      }));
      console.log(`[${pattern}] ${label}: SLO violations=${run.metrics.slo.count} dur=${run.metrics.slo.durationSeconds}s avgReplicas=${run.metrics.cost.avgReplicas.toFixed(2)} nodeHours=${run.metrics.cost.nodeHours.toFixed(3)}`);
    }
  }

  // ---- Multi-seed runs (drives statistical significance + mean/std/CI) ----
  const controllerName = new Map(CONTROLLERS.map(({ cls }) => [cls, new cls({ controlIntervalS: 15 }).name]));
  for (const seed of REPLICATE_SEEDS) {
    for (const pattern of PATTERNS) {
      for (const { cls, label } of CONTROLLERS) {
        // The canonical seed's detailed run above already covers this
        // (pattern, controller) pair; reuse it instead of re-simulating.
        const key = `${pattern}__${controllerName.get(cls)}`;
        const run = (seed === CANONICAL_SEED && canonicalByPC[key])
          ? canonicalByPC[key]
          : runOne(pattern, seed, cls, label);
        summary.multiSeedRuns.push({
          pattern, seed, controller: run.controller, label,
          slo: run.metrics.slo, cost: run.metrics.cost,
          timeToScale: run.metrics.timeToScale.avgTimeToScaleSeconds,
          churnPerHour: run.metrics.stability.churnPerHour,
        });
      }
    }
    console.log(`[seed ${seed}] multi-seed replicate complete`);
  }

  // Aggregate cross-pattern averages per controller from the CANONICAL run
  // (paper-style summary tables; kept for backward-compatible per-pattern figures).
  const byController = {};
  for (const run of summary.runs) {
    byController[run.controller] = byController[run.controller] || { label: run.label, runs: [] };
    byController[run.controller].runs.push(run);
  }
  summary.aggregate = Object.entries(byController).map(([controller, { label, runs }]) => ({
    controller,
    label,
    avgSloViolationCount: mean(runs.map((r) => r.metrics.slo.count)),
    avgSloViolationDurationSeconds: mean(runs.map((r) => r.metrics.slo.durationSeconds)),
    avgTimeToScaleSeconds: mean(runs.map((r) => r.metrics.timeToScale.avgTimeToScaleSeconds).filter((v) => v != null)),
    avgReplicas: mean(runs.map((r) => r.metrics.cost.avgReplicas)),
    avgNodeHours: mean(runs.map((r) => r.metrics.cost.nodeHours)),
    avgChurnPerHour: mean(runs.map((r) => r.metrics.stability.churnPerHour)),
    avgOscillationsPerHour: mean(runs.map((r) => r.metrics.stability.oscillationsPerHour)),
  }));

  const naiveBaseline = summary.aggregate.find((a) => a.controller === 'default_hpa');
  const costBaseline = summary.aggregate.find((a) => a.controller === 'tuned_hpa');
  for (const row of summary.aggregate) {
    row.sloDurationReductionPct = naiveBaseline
      ? ((naiveBaseline.avgSloViolationDurationSeconds - row.avgSloViolationDurationSeconds) / naiveBaseline.avgSloViolationDurationSeconds) * 100
      : null;
    row.timeToScaleImprovementPct = naiveBaseline
      ? ((naiveBaseline.avgTimeToScaleSeconds - row.avgTimeToScaleSeconds) / naiveBaseline.avgTimeToScaleSeconds) * 100
      : null;
    row.sloDurationReductionVsTunedPct = costBaseline
      ? ((costBaseline.avgSloViolationDurationSeconds - row.avgSloViolationDurationSeconds) / costBaseline.avgSloViolationDurationSeconds) * 100
      : null;
    row.costReductionPct = costBaseline
      ? ((costBaseline.avgNodeHours - row.avgNodeHours) / costBaseline.avgNodeHours) * 100
      : null;
  }

  // ---- Multi-seed statistics: mean/std/95% CI per controller across all (pattern, seed) pairs ----
  const byControllerMS = {};
  for (const r of summary.multiSeedRuns) {
    byControllerMS[r.controller] = byControllerMS[r.controller] || { label: r.label, rows: [] };
    byControllerMS[r.controller].rows.push(r);
  }
  summary.multiSeedStats = Object.entries(byControllerMS).map(([controller, { label, rows }]) => ({
    controller,
    label,
    n: rows.length,
    sloViolationDurationSeconds: summarizeSamples(rows.map((r) => r.slo.durationSeconds)),
    nodeHours: summarizeSamples(rows.map((r) => r.cost.nodeHours)),
    timeToScaleSeconds: summarizeSamples(rows.map((r) => r.timeToScale)),
    churnPerHour: summarizeSamples(rows.map((r) => r.churnPerHour)),
  }));

  // ---- Paired significance tests (Proactive vs. each other controller), pairing on (pattern, seed) ----
  function alignedSamples(controllerA, controllerB, metricFn) {
    const a = [], b = [];
    for (const pattern of PATTERNS) {
      for (const seed of REPLICATE_SEEDS) {
        const ra = summary.multiSeedRuns.find((r) => r.pattern === pattern && r.seed === seed && r.controller === controllerA);
        const rb = summary.multiSeedRuns.find((r) => r.pattern === pattern && r.seed === seed && r.controller === controllerB);
        if (ra && rb) { a.push(metricFn(ra)); b.push(metricFn(rb)); }
      }
    }
    return [a, b];
  }
  const compareAgainst = ['tuned_hpa', 'hpa_vpa', 'reactive_multi_signal', 'default_hpa'];
  summary.significance = compareAgainst.map((other) => {
    const [aSlo, bSlo] = alignedSamples('proactive', other, (r) => r.slo.durationSeconds);
    const [aCost, bCost] = alignedSamples('proactive', other, (r) => r.cost.nodeHours);
    return {
      comparison: `proactive_vs_${other}`,
      n: aSlo.length,
      sloViolationDuration: pairedTTest(aSlo, bSlo),
      nodeHours: pairedTTest(aCost, bCost),
    };
  });

  // Forecast-accuracy summary (proactive controller, canonical seed), averaged across patterns
  const proactiveRuns = summary.runs.filter((r) => r.controller === 'proactive');
  summary.forecastSummary = {};
  const VARIANTS = ['model', 'holtOnly', 'persistence', 'movingAverage', 'linearDrift'];
  for (const sig of FORECAST_SIGNALS) {
    summary.forecastSummary[sig] = {};
    for (const variant of VARIANTS) {
      summary.forecastSummary[sig][variant] = {
        accuracyPct: mean(proactiveRuns.map((r) => r.forecast[sig][variant].accuracyPct)),
        mape: mean(proactiveRuns.map((r) => r.forecast[sig][variant].mape)),
        rmse: mean(proactiveRuns.map((r) => r.forecast[sig][variant].rmse)),
        r2: mean(proactiveRuns.map((r) => r.forecast[sig][variant].r2)),
      };
    }
  }
  function avgCls(field, model) {
    return mean(proactiveRuns.map((r) => r.classification[model][field]).filter((v) => v != null));
  }
  function avgClsWindowed(field, model) {
    return mean(proactiveRuns.map((r) => r.classificationWindowed[model][field]).filter((v) => v != null));
  }
  summary.classificationSummary = {
    holt: { precision: avgCls('precision', 'model'), recall: avgCls('recall', 'model'), f1: avgCls('f1', 'model'), accuracy: avgCls('accuracy', 'model') },
    persistence: { precision: avgCls('precision', 'persistence'), recall: avgCls('recall', 'persistence'), f1: avgCls('f1', 'persistence'), accuracy: avgCls('accuracy', 'persistence') },
  };
  summary.classificationSummaryWindowed = {
    holt: { precision: avgClsWindowed('precision', 'model'), recall: avgClsWindowed('recall', 'model'), f1: avgClsWindowed('f1', 'model'), accuracy: avgClsWindowed('accuracy', 'model') },
    persistence: { precision: avgClsWindowed('precision', 'persistence'), recall: avgClsWindowed('recall', 'persistence'), f1: avgClsWindowed('f1', 'persistence'), accuracy: avgClsWindowed('accuracy', 'persistence') },
  };
  summary.thresholdSweepSummary = {
    bestF1: mean(proactiveRuns.map((r) => r.thresholdSweep.bestF1.f1)),
    bestF1Precision: mean(proactiveRuns.map((r) => r.thresholdSweep.bestF1.precision)),
    bestF1Recall: mean(proactiveRuns.map((r) => r.thresholdSweep.bestF1.recall)),
    prAuc: mean(proactiveRuns.map((r) => r.thresholdSweep.prAuc)),
  };

  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  console.log(`\nwrote ${SUMMARY_FILE}`);
}

if (require.main === module) main();
module.exports = { main };
