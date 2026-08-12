# Proactive, Multi-Signal SLO- & Cost-Aware Autoscaler

A Kubernetes-free reproduction and extension of ["An SLO Driven and Cost-Aware Autoscaling
Framework for Kubernetes"](./2512.pdf). This project reframes the original paper's reactive,
multi-signal controller as a **proactive, forecast-driven** controller that scales on 45-second-ahead
predictions of p99 latency, CPU, RAM, and connection-pool utilization instead of on current values —
implemented as a standalone Node.js closed-loop simulator, with no cluster or container runtime
required.

It also includes a **Reactive Multi-Signal** controller: the same signal set, thresholds, and
guardrails as the proposed controller, but acting on current instead of forecast values. This isolates
how much of the improvement is actually attributable to forecasting, as opposed to simply having more
signals — see "Headline results" below.

## Layout

```
src/data/generateDummyData.js   Synthetic demand traces (bursty, queue-driven, mixed) + 8 seeded replicates
src/engine/systemModel.js       Closed-loop queueing simulator (CPU/RAM/latency/conn-pool/nodes)
src/engine/forecaster.js        Holt's damped-trend forecaster, naive persistence, moving-average,
                                 linear-drift, and an adaptive inverse-error-weighted Holt/persistence blend
src/engine/controllers.js       Default HPA, Tuned HPA, HPA+VPA, Reactive Multi-Signal (isolation
                                 baseline), and the proposed Proactive controller
src/engine/simulate.js          Runs one (controller, workload) closed-loop simulation
src/engine/runSimulation.js     Runs all controllers x all workloads x 8 seeds; computes all metrics,
                                 multi-seed mean/std/CI, and paired significance tests
src/engine/runSensitivity.js    Horizon/damping-factor sensitivity sweep + tune/holdout hyperparameter
                                 calibration and validation
src/engine/metrics.js           SLO/cost/stability/forecast-accuracy/classification metrics, plus
                                 windowed classification, threshold sweeps, and significance testing
src/server.js + src/public/     Express dashboard (vanilla canvas charts, no CDN dependency)
scripts/make_figures.py         Renders the PNG figures used in the paper (matplotlib, via .venv)
paper/main.tex                  IEEE-format LaTeX paper (compiles to paper/main.pdf)
results/                        Generated dummy data, per-run timeseries, summary.json, sensitivity.json
```

## Running it

**Prerequisites:** Node.js 18+ (no Kubernetes/Docker/cluster runtime needed).

```bash
git clone <this-repo-url>
cd major
npm install
npm run all          # generate workloads (+ 8 seeded replicates), run all controllers x patterns x seeds,
                      # and run the horizon/phi sensitivity sweep + tune/holdout calibration validation
npm start             # serves the dashboard at http://localhost:4173
```

`npm run all` must be run at least once before `npm start`, since the dashboard reads its data
from the `results/` directory that `npm run all` generates. It can also be run in stages:

```bash
npm run generate      # writes synthetic demand traces to results/raw/
npm run simulate      # runs all controllers x workloads x seeds, writes results/summary.json
                       # and per-run timeseries to results/timeseries/
npm run sensitivity   # runs the horizon/phi sweep + calibration, writes results/sensitivity.json
```

Once `npm start` is running, open `http://localhost:4173` in a browser to view the interactive
dashboard (controller comparisons, per-run timeseries charts, sensitivity sweep results).

To regenerate the paper's figures and recompile the PDF:

```bash
python3 -m venv .venv && .venv/bin/pip install matplotlib numpy
.venv/bin/python scripts/make_figures.py
cd paper && pdflatex main.tex && pdflatex main.tex   # run twice for cross-references
```

(`paper/IEEEtran.cls`, `algorithm.sty`, `algorithmic.sty`, `algorithmicx.sty`, and
`algpseudocode.sty` are vendored directly into `paper/` since they aren't part of a base TeX Live
install.)

## Headline results

**The central comparison** is the proposed controller against **Reactive Multi-Signal**, the
same signal set/thresholds/guardrails but acting on current rather than forecast values — this is
what isolates forecasting's own contribution. Pooled across 3 workload patterns x 8 demand seeds
(24 replicates), at the damping factor calibrated by a tune/holdout sensitivity sweep
($\phi=0.97$, see `results/sensitivity.json`):

| Autoscaler | SLO violation duration (mean ± std) | Node-hours | vs. Proposed |
|---|---|---|---|
| Default HPA | 568.6 ± 225.1 s | 2.23 | $p<10^{-4}$ |
| Tuned HPA | 150.9 ± 38.6 s | 5.58 | $p<10^{-4}$ |
| HPA + VPA (reactive multi-metric) | 125.8 ± 28.9 s | 5.58 | $p=2.9\times10^{-4}$ |
| Reactive Multi-Signal (isolation baseline) | 125.8 ± 28.9 s | 5.58 | $p=2.9\times10^{-4}$ |
| **Proactive (proposed)** | **112.7 ± 27.5 s** | **5.57** | — |

Two things worth noting before taking the headline number at face value:

- **HPA+VPA and Reactive Multi-Signal are numerically identical**, on every pattern and seed —
  widening the signal set to include RAM/connection-pool/backlog bought nothing on its own in this
  simulator, because CPU and p99 latency dominate the risk-fusion rule regardless. The wider signal
  set is not why the proposed controller wins.
- Forecasting's ~10% improvement over Reactive Multi-Signal **only appears once the damping factor
  is calibrated**: at the originally hand-picked value ($\phi=0.85$–$0.9$), the same comparison is
  *not* statistically significant. The calibrated value was selected on 5 of 8 seeds and confirmed
  significant on the disjoint 3-seed holdout set ($p=0.014$).

Forecast accuracy (`100 − SMAPE/2`, adaptive blend vs. naive persistence): **RAM 96.2%** (best,
$R^2=0.53$), **connection pool 88.3% vs. 90.6%**, **p99 latency 82.3% vs. 85.9%**, **CPU 81.6% vs.
83.2%** — persistence remains the more accurate *point* forecaster for the two heavy-tailed signals,
but the same forecasts still add detection value on the windowed overload-classification task (F1
0.36–0.43 vs. ≈0.16 under a strict point-in-time definition). See `paper/main.tex` Section VI for
the full discussion, statistical methodology, and sensitivity analysis.

Full methodology, architecture diagram, algorithm listing, and all figures/tables are in
`paper/main.pdf`.
