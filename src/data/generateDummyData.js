'use strict';
/**
 * Dummy workload demand generator.
 *
 * Produces synthetic request-rate (rps) traces for three representative
 * workload patterns, mirroring the evaluation methodology of the reference
 * paper (bursty, queue-driven, mixed). These traces are the *input demand*
 * to the closed-loop system simulator (src/engine/*) — they are generated
 * independently of any autoscaler so all controllers are compared on
 * identical demand.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', '..', 'results', 'raw');
const DURATION_S = 3600; // 1 hour @ 1s resolution
const DT = 1;
const SEED = 42; // canonical seed: used for the headline single-run figures/dashboard
// Additional replicate seeds so the evaluation can report mean +/- std / CI
// and significance tests across independently-sampled demand traces per
// pattern, rather than a single run each (see runSimulation.js).
const REPLICATE_SEEDS = [42, 7, 13, 19, 23, 31, 37, 41];
// Held-out split used by runSensitivity.js: hyperparameters (forecast horizon,
// damping factor) are selected using only TUNE_SEEDS, then validated on the
// disjoint HOLDOUT_SEEDS, so the reported validation numbers are not the same
// data used to pick the configuration.
const TUNE_SEEDS = [42, 7, 13, 19, 23];
const HOLDOUT_SEEDS = [31, 37, 41];

// Deterministic PRNG (mulberry32) so runs are reproducible.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGaussian(rand) {
  return function gaussian(mu, sigma) {
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mu + sigma * z;
  };
}

function genBursty(rand, gaussian) {
  const rps = [];
  const base = 220;
  // Poisson-ish spike events every ~300-500s
  const spikes = [];
  let t = 60;
  while (t < DURATION_S - 60) {
    t += 260 + rand() * 220;
    spikes.push({ start: t, dur: 25 + rand() * 45, mag: 3.5 + rand() * 4.5 });
  }
  for (let i = 0; i < DURATION_S; i += DT) {
    let demand = base + 25 * Math.sin((2 * Math.PI * i) / 900) + gaussian(0, 8);
    for (const s of spikes) {
      if (i >= s.start && i <= s.start + s.dur) {
        const phase = (i - s.start) / s.dur; // 0..1
        // fast rise, slower decay (bursty realism)
        const envelope = phase < 0.2 ? phase / 0.2 : Math.exp(-((phase - 0.2) / 0.5));
        demand += base * (s.mag - 1) * envelope;
      }
    }
    rps.push(Math.max(10, demand));
  }
  return rps;
}

function genQueueDriven(rand, gaussian) {
  const rps = [];
  const base = 140;
  const surges = [];
  let t = 100;
  while (t < DURATION_S - 200) {
    t += 400 + rand() * 300;
    surges.push({ start: t, dur: 180 + rand() * 220, mag: 3 + rand() * 3 });
  }
  for (let i = 0; i < DURATION_S; i += DT) {
    let demand = base + gaussian(0, 6);
    for (const s of surges) {
      const end = s.start + s.dur;
      if (i >= s.start && i <= end) {
        // trapezoid: ramp-up 15%, plateau 70%, ramp-down 15%
        const phase = (i - s.start) / s.dur;
        let envelope;
        if (phase < 0.15) envelope = phase / 0.15;
        else if (phase > 0.85) envelope = (1 - phase) / 0.15;
        else envelope = 1;
        demand += base * (s.mag - 1) * envelope;
      }
    }
    rps.push(Math.max(10, demand));
  }
  return rps;
}

function genMixed(rand, gaussian) {
  const rps = [];
  const base = 180;
  // background batch job steps (long, held)
  const batchSteps = [];
  let t = 200;
  while (t < DURATION_S - 300) {
    t += 500 + rand() * 400;
    batchSteps.push({ start: t, dur: 300 + rand() * 300, add: 60 + rand() * 60 });
  }
  // occasional short bursts layered on top
  const bursts = [];
  t = 150;
  while (t < DURATION_S - 60) {
    t += 350 + rand() * 300;
    bursts.push({ start: t, dur: 20 + rand() * 30, mag: 2.5 + rand() * 3 });
  }
  for (let i = 0; i < DURATION_S; i += DT) {
    let demand = base + 40 * Math.sin((2 * Math.PI * i) / 1800 + 1.2) + gaussian(0, 10);
    for (const b of batchSteps) {
      if (i >= b.start && i <= b.start + b.dur) demand += b.add;
    }
    for (const s of bursts) {
      if (i >= s.start && i <= s.start + s.dur) {
        const phase = (i - s.start) / s.dur;
        const envelope = phase < 0.25 ? phase / 0.25 : Math.exp(-((phase - 0.25) / 0.4));
        demand += base * (s.mag - 1) * envelope;
      }
    }
    rps.push(Math.max(10, demand));
  }
  return rps;
}

function build(name, seed, series) {
  return {
    pattern: name,
    dt: DT,
    durationSeconds: DURATION_S,
    seed,
    points: series.map((rps, i) => ({ t: i * DT, rps: Number(rps.toFixed(2)) })),
  };
}

function generateAllPatterns(seed) {
  const rand = mulberry32(seed);
  const gaussian = makeGaussian(rand);
  // Each generator advances the *same* PRNG in sequence (bursty, then
  // queue-driven, then mixed) so a given seed deterministically produces
  // one self-consistent triple of traces, rather than three independent
  // single-pattern seeds -- this only matters for reproducibility bookkeeping.
  return {
    bursty: build('bursty', seed, genBursty(rand, gaussian)),
    queue_driven: build('queue_driven', seed, genQueueDriven(rand, gaussian)),
    mixed: build('mixed', seed, genMixed(rand, gaussian)),
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Canonical seed: also written as `<pattern>.json` (unsuffixed) for
  // backward compatibility with the dashboard and the single-run figures.
  const canonical = generateAllPatterns(SEED);
  for (const [name, data] of Object.entries(canonical)) {
    const file = path.join(OUT_DIR, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
    console.log(`wrote ${file} (${data.points.length} points)`);
  }
  // Full replicate set (including the canonical seed again, as seed index 0)
  // for the multi-seed statistical evaluation in runSimulation.js.
  for (const seed of REPLICATE_SEEDS) {
    const datasets = generateAllPatterns(seed);
    for (const [name, data] of Object.entries(datasets)) {
      const file = path.join(OUT_DIR, `${name}__seed${seed}.json`);
      fs.writeFileSync(file, JSON.stringify(data));
    }
    console.log(`wrote replicate seed ${seed} (bursty/queue_driven/mixed)`);
  }
}

if (require.main === module) main();
module.exports = {
  genBursty, genQueueDriven, genMixed, generateAllPatterns,
  REPLICATE_SEEDS, TUNE_SEEDS, HOLDOUT_SEEDS, SEED,
};
