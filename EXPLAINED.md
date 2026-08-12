# Understanding This Project From First Principles

This document explains what this project is, why it exists, and how every piece of it works —
starting from "what problem are we even solving" and building up to the actual code. It's written
so you can walk a teacher through it without assuming they already know the jargon.

---

## 1. The one-sentence version

This project asks: **if a system that automatically adds/removes servers under load reacts to
predictions of the near future instead of the present, does it actually keep the app faster and
avoid wasting money — or does that benefit disappear once you control for everything else?** — and
answers it with a from-scratch simulator, five competing autoscaling strategies, and a statistical
evaluation designed specifically to make that comparison fair.

---

## 2. The problem, from scratch

### 2.1 What is "autoscaling"?

Imagine a web service (say, an online shop) running on several identical copies of the same
program — call each copy a **replica**. More replicas = more capacity to handle requests, but also
more money spent on servers. Traffic isn't constant: it spikes during sales, dips at night, surges
when something goes viral. **Autoscaling** is the automated process of deciding, moment to moment,
how many replicas should be running.

This is a balancing act between two costs:

- **Too few replicas** → requests queue up, response times blow past what users will tolerate.
- **Too many replicas** → the app is fast, but you're paying for idle capacity nobody is using.

### 2.2 What is an SLO?

A **Service Level Objective (SLO)** is a promised performance bound — e.g. "99% of requests
must complete in under 300ms." This project's SLO target is exactly that: **p99 latency ≤ 300ms**
(p99 = the 99th-percentile response time — the value that 99% of requests are faster than). SLO
violations are the thing autoscaling exists to prevent.

### 2.3 Why is this hard? The fundamental lag problem

Here's the crux of the whole project. Any autoscaler, no matter how smart, has to:

1. **Observe** a signal (e.g., CPU usage climbed to 85%).
2. **Decide** a new replica count.
3. **Act** — actually start new replicas, and if there isn't spare server capacity, boot an
   entirely new physical/virtual machine first.

Step 3 is *slow*. In this project's simulator, a brand-new node takes **45 seconds** to become
usable. Meanwhile demand keeps climbing. A **reactive** controller — one that only responds to
what's happening *right now* — only starts that 45-second clock *after* the problem is already
visible in the metrics. By the time replicas actually arrive, the traffic spike may already have
caused minutes of slow responses.

This project's central idea: what if the controller predicted, 30–45 seconds ahead of time, that
CPU/latency/etc. are *about to* cross the danger threshold, and started provisioning *before* the
threshold is actually crossed? That's the difference between **reactive** and **proactive**
scaling, and it's the whole subject of this paper.

### 2.4 What already exists, and its known gaps

Kubernetes ships a **Horizontal Pod Autoscaler (HPA)**: the textbook version watches one signal
(usually CPU%) and computes

```
desired_replicas = current_replicas × (current_CPU / target_CPU)
```

There's also a **Vertical Pod Autoscaler (VPA)**, which resizes individual replicas rather than
adding more of them; "HPA+VPA" here means a reactive controller that also folds a RAM
recommendation into the same max-of-signals decision.

Four known limitations motivate this project:

1. **Reactive-only timing** — even a controller watching five signals is still only ever reacting
   to values that are already stale by the time an action lands.
2. **Narrow signal coverage** — real systems mostly only wire up CPU (and maybe latency) as a
   scaling trigger, ignoring RAM (which has much "stickier," slower dynamics — think garbage
   collection sawtooths) and connection-pool exhaustion (which causes queueing delay *before* it
   shows up in CPU at all).
3. **Pod/node schedulability mismatch** — a controller can ask for 20 replicas, but if the
   underlying nodes don't have room, those replicas just sit "pending" until a new node boots.
   A purely reactive controller can't get ahead of that boot delay.
4. **No one measures whether the forecast is any good** — papers that add forecasting to
   autoscaling rarely report the forecaster's own accuracy, so it's impossible to tell how much of
   any improvement is really coming from the prediction, versus just from other design choices
   bundled in at the same time.

This project is explicitly built to close gap #4: it isolates *forecasting itself* as a variable,
holding everything else (which signals, which thresholds, which safety rules) constant.

---

## 3. The core experimental design

### 3.1 The trap this project deliberately avoids

Suppose you compare "old dumb autoscaler" against "new fancy forecasting autoscaler" and the new
one wins. Is that because of the forecasting? Or is it just because the new one also happens to
look at more signals (RAM, connection pool) that the old one ignored? You can't tell — the
comparison is confounded.

This project's fix: build a fifth controller, the **Reactive Multi-Signal** controller, that uses
the *exact same* signals, thresholds, and safety rules as the proposed proactive controller — the
only difference is it acts on the **current** value of each signal instead of a **forecast**. Now
any measured difference between "Reactive Multi-Signal" and "Proactive" can only be attributed to
one thing: forecasting. This is the paper's central comparison.

### 3.2 The five controllers, in increasing sophistication

| # | Controller | Signals used | Acts on |
|---|---|---|---|
| 1 | Default HPA | CPU only | current value |
| 2 | Tuned HPA | CPU + p99 latency | current value |
| 3 | HPA + VPA | CPU + p99 latency + RAM | current value |
| 4 | **Reactive Multi-Signal** (isolation baseline) | CPU + p99 latency + RAM + connection pool + backlog | current value |
| 5 | **Proactive (proposed)** | same 5 signals as #4 | **forecast**, 30–45s ahead |

Controllers 1–3 exist to reproduce the reference paper's original baselines. Controller 4 is this
project's own methodological addition, built specifically to make #5's win (if any) mean something.

---

## 4. How do you test an autoscaler without a real server cluster?

You can't ethically (or cheaply) spin up real Kubernetes clusters and throw real traffic at them
dozens of times just to compare five strategies across many random traffic patterns. So this
project builds a **closed-loop simulator** — a piece of software that mimics how a real
horizontally-scaled service behaves, in-process, with no cluster or containers involved.

"Closed-loop" means: the controller observes the system's signals → makes a decision → the system
reacts to that decision on the next tick → the controller observes the *new* signals → and so on,
second by second, for a simulated hour. This is exactly the same feedback loop a real autoscaler
sits inside; only the "service" is a stylized queueing model instead of a Kubernetes cluster.

### 4.1 The queueing-theory core

At every one-second tick, given incoming demand `λ` (requests/second) and current replica count
`n` (each replica handles `μ = 50` req/s at 100% load):

**Utilization:**
```
ρ = min(λ / (n·μ), 0.995)
```
`ρ` is the fraction of total capacity currently being used — the single most important number in
queueing theory. As `ρ → 1`, queues (and therefore latency) blow up nonlinearly, not linearly.

**Latency percentiles**, via the classic M/M/1 queue response-time-tail approximation:
```
T_p = -ln(1 - p) × T_service / (1 - ρ)  +  backlog_drain_delay
```
where `T_service = 20ms` is the average time to handle one request. Notice the `1/(1-ρ)` term:
this is *why* latency explodes as utilization approaches 1 — it's not a straight line, it's a curve
that goes vertical near full capacity. p50, p90, and p99 are all computed from this same formula,
just plugging in `p = 0.5, 0.9, 0.99`.

**Backlog**: when demand exceeds capacity, the excess doesn't vanish — it queues up ("backlog"),
and only drains once capacity again exceeds demand. This is why a burst can cause slow responses
that persist *after* the burst itself has ended — draining a backlog takes time even once new
requests stop arriving.

**CPU**: modeled as roughly proportional to `ρ`, smoothed with an exponential moving average to
mimic real-world metrics-collection lag.

**RAM**: deliberately modeled with *different, stickier* dynamics than CPU — a rolling average of
recent (not instantaneous) utilization, plus a small sawtooth pattern (mimicking garbage-collection
cycles) and a per-replica fixed-overhead term. This is the paper's way of testing whether a
controller that treats RAM identically to CPU is making a bad assumption.

**Connection-pool utilization**: modeled via **Little's Law**, a foundational queueing-theory
result:
```
L = λ × W
```
(the average number of requests "in the system" equals arrival rate times average time spent in
the system). Once pool utilization exceeds 90%, the model feeds a latency *penalty* back in — this
reproduces a real phenomenon called connection-pool backpressure, where running low on connections
itself becomes a source of additional delay, on top of whatever caused the shortage in the first
place.

**Node provisioning**: replicas are grouped into "nodes" (10 replica-slots each). If a controller
asks for more replicas than there's room for, new nodes are queued for provisioning and take 45
simulated seconds to arrive — modeling real cloud VM/container boot time. Until they arrive, the
requested replicas simply cannot exist; this is the "pod/node schedulability mismatch" made
concrete.

Put together, this model is a compact but honestly-motivated stand-in for a real, horizontally
scaled backend service, cheap enough to run thousands of one-hour simulations in seconds, with
every constant (capacity per replica, boot delay, service time) disclosed directly in the code
rather than hidden in a black box.

---

## 5. Forecasting, from first principles

The proactive controller's entire advantage rests on being able to predict, e.g., "p99 latency
30 seconds from now" from the sequence of p99 latency values observed so far. Here's how, building
up from the simplest possible idea to what's actually used.

### 5.1 The simplest forecast: persistence

**"Whatever it is right now, is probably close to what it'll be in a few seconds."**
```
predicted(t + h) = observed(t)
```
This is called a **persistence** (or "naive") forecast. It sounds too simple to be useful, but it's
a surprisingly strong baseline for anything that changes slowly or unpredictably relative to the
forecast horizon — and this project's own results show it's *still* the more accurate point
forecaster for two of its four signals (see §8).

### 5.2 A smarter forecast: exponential smoothing with trend (Holt's method)

Persistence has no notion of *direction* — if a signal has been steadily climbing, persistence
still just predicts "flat." **Holt's linear method** (double exponential smoothing) fixes this by
tracking two running quantities:

- **Level** (`ℓ`): a smoothed estimate of the current value.
- **Trend** (`b`): a smoothed estimate of how fast the level is currently rising or falling.

Updated every tick from the newly observed value `y`:
```
ℓ_t = α·y_t + (1-α)·(ℓ_{t-1} + φ·b_{t-1})
b_t = β·(ℓ_t - ℓ_{t-1}) + (1-β)·φ·b_{t-1}
```
`α` and `β` are "how much do I trust the newest data point vs. my running estimate" weights (0–1).
The `h`-step-ahead forecast is then simply "current level, plus `h` steps' worth of trend":
```
ŷ(t+h) = ℓ_t + b_t × (φ + φ² + ... + φ^h)
```

### 5.3 Why the trend is *damped* (the `φ` term)

If you let trend extrapolate forever in a straight line, a single short-lived spike gets predicted
to keep growing indefinitely — the paper's own preliminary experiments hit exactly this failure
mode: a brief burst caused the un-damped model to massively over-provision for tens of minutes
afterward. **Damping** (Gardner & McKenzie's method) multiplies the trend's influence by `φ < 1` at
each future step, so its contribution decays geometrically and the forecast *converges* instead of
running away. `φ` close to 1 = "trust the trend for longer"; `φ` further from 1 = "trend fades out
fast." Picking the right value of `φ` turns out to matter a lot (see §9's calibration story).

### 5.4 Why neither model wins outright — and the fix (adaptive blending)

Holt's trend-extrapolation helps on smooth, slow-moving signals (RAM). But for spiky,
fast-transient signals (p99 latency, connection-pool utilization), extrapolating a trend that's
really just noise actively *hurts* — persistence alone does better there. Rather than picking one
model per signal by hand, this project runs **both models simultaneously per signal** and blends
them, weighting each by the *inverse of its own recent error* — a forecaster that's been more
accurate recently earns more say in the final answer:
```
weight_Holt = (1/error_Holt) / (1/error_Holt + 1/error_persistence)     [clipped to 5%–95%]
forecast = weight_Holt × Holt_forecast + (1 - weight_Holt) × persistence_forecast
```
Each model's own error is itself tracked with an exponential moving average (120-second half-life),
and — critically — a forecast's error is only ever scored *after* enough real time has passed to
check it against what actually happened. This keeps the whole scheme "causal": at no point does it
peek at data from the future to score itself, which would invalidate the entire evaluation. All of
this runs in O(1) time per tick with no offline training phase — a deliberate design constraint,
since a "smarter" model requiring training data or retraining pipelines would undercut the
practical, drop-in-anywhere argument the paper is making.

This machinery (Holt + persistence + adaptive blend) is applied independently to each of five
signals: p99 latency, CPU, RAM, connection-pool utilization, and backlog.

---

## 6. The decision pipeline: from forecasts to a replica count

Once each signal is forecast `h = 45` seconds ahead, the proactive controller turns those five
numbers into a single "how many replicas do we want" decision, in four stages:

### Stage 1 — Risk fusion

Each forecast is turned into a **risk ratio**: forecast value ÷ the trigger threshold for that
signal (p99: 250ms, CPU: 60%, RAM: 75%, connection pool: 85%). A ratio above 1 means "this signal
is predicted to breach its own threshold." The controller takes the **maximum** across all four —
i.e., *whichever signal is closest to (or over) its limit drives the decision*. This reflects a
simple but important idea: a service is only as healthy as its most-stressed subsystem.
```
risk = max(p99_forecast/250, cpu_forecast/60, ram_forecast/75, pool_forecast/85)
desired_from_risk = current_replicas × risk
```

### Stage 2 — Backlog is handled separately, additively

Backlog is a *count* of unserved requests, not a *utilization ratio*, so it can't be folded into
the max-ratio formula above — instead, the controller computes exactly how many extra replicas
would be needed to drain the forecast backlog within a fixed 30-second target, and simply adds that
on top:
```
extra_replicas_for_backlog = forecast_backlog / (30s × 50 req/s per replica)
raw_target = desired_from_risk + extra_replicas_for_backlog
```

### Stage 3 — Guardrails (this is the "cost-aware" and "stability" part)

Four safety rules are applied, in order, and they are **identical** for the reactive and proactive
multi-signal controllers — so any comparison between them is purely about timing, not about one
having looser rules:

1. **Hard bounds**: never fewer than 2, never more than 60 replicas.
2. **Asymmetric stabilization window** — this is the actual cost-control mechanism. Scaling *up*
   can happen immediately, but scaling *down* only happens if every recommendation over the
   trailing 120 seconds agreed it was safe to shrink. This deliberately biases the system toward
   "keep paying for a bit of extra capacity rather than risk flapping" — cost-awareness expressed
   as patience, not as a hard cost budget.
3. **Bounded step size**: at most double the replica count in one tick, at most halve it — prevents
   wild, one-shot swings.
4. **Cooldown**: if the last action was less than 15 seconds ago and this new recommendation
   reverses direction, hold the previous target instead — prevents oscillating back and forth.

### Stage 4 — Actuation

The final replica target is handed to the same node-provisioning logic described in §4.1: if there
isn't room on existing nodes, new node boot-up is triggered, 45 seconds ahead of when it will
actually be needed if the forecast is accurate — this is the mechanism by which forecasting
directly attacks the "pod/node schedulability mismatch" problem from §2.4.

---

## 7. How "good" is measured — the metrics

Running a simulation produces a second-by-second timeseries (demand, replicas, CPU, RAM, latency,
etc.) for each (controller, workload-pattern) pair. Several metrics are computed from that:

- **SLO violation duration**: total seconds where p99 latency exceeded 300ms. Lower is better —
  this is the headline "did users experience slowness" number.
- **Cost (node-hours)**: how many node-hours of infrastructure were provisioned over the run.
  Lower is cheaper, but *too* low usually means more SLO violations — this is the fundamental
  tradeoff from §2.1, made measurable.
- **Stability** (churn/oscillation events per hour): how often the replica count changes, and how
  often it reverses direction — a controller that's technically fast but flaps constantly is
  operationally undesirable even if its headline numbers look good.
- **Time-to-scale**: for detected demand upshifts, how long until replica capacity actually catches
  up to the new demand level.
- **Forecast accuracy**: for the proactive controller specifically, every forecast it ever made is
  logged alongside what actually happened `h` seconds later, and scored by:
  - **SMAPE-based accuracy %** (`100 − SMAPE/2`) — a bounded, symmetric alternative to plain
    percentage error that doesn't blow up when the true value is near zero (which happens often for
    latency during calm periods).
  - **R²** — how much of the signal's real variance the forecast explains.
- **Overload classification** (precision/recall/F1): treats "will this breach the SLO?" as a
  yes/no prediction problem. Two framings are reported: a strict *point-in-time* definition (did
  latency exceed the SLO at *exactly* `t+h`?) and a more operationally realistic *windowed*
  definition (did it exceed the SLO at *any point* within the next `h` seconds?) — a controller
  cares about the latter far more than the former, and the paper shows the two framings give very
  different-looking numbers for the same underlying forecasts.

### 7.1 Why statistics, not just one run

A single one-hour simulation run is one random sample of what traffic could look like — comparing
controllers on just one such run risks the conclusion being an artifact of that particular random
traffic. To guard against this:

- Every controller is run against **3 distinct workload patterns** (bursty, queue-driven, mixed —
  representing qualitatively different traffic shapes) **× 8 independently-generated demand traces
  per pattern** (24 runs total per controller), all controllers seeing *identical* demand within
  each run so the comparison is apples-to-apples.
- Differences are tested with a **paired two-tailed t-test**: because the same demand trace is fed
  to every controller, the natural pairing (same trace, different controller) cancels out cross-run
  randomness and isolates the controller's own effect, giving a proper p-value rather than an
  eyeballed "it looks bigger."
- Any *hyperparameter* (like the forecaster's damping factor `φ`, or the forecast horizon) is
  **calibrated on one subset of seeds (5 of 8) and validated on the other, disjoint 3** — exactly
  the train/test split idea from machine learning, applied here to guard against quietly tuning a
  knob until it happens to make the results look best on the very data used to report them.

---

## 8. The headline results — and their honest caveats

Pooled across all 3 patterns × 8 seeds (24 runs), at the calibrated damping factor `φ = 0.97`:

| Controller | SLO violation duration (mean ± std) | Node-hours | vs. Proactive |
|---|---|---|---|
| Default HPA | 568.6 ± 225.1 s | 2.23 | p < 10⁻⁴ |
| Tuned HPA | 150.9 ± 38.6 s | 5.58 | p < 10⁻⁴ |
| HPA + VPA | 125.8 ± 28.9 s | 5.58 | p = 2.9×10⁻⁴ |
| Reactive Multi-Signal | 125.8 ± 28.9 s | 5.58 | p = 2.9×10⁻⁴ |
| **Proactive (proposed)** | **112.7 ± 27.5 s** | **5.57** | — |

Two things worth understanding (and worth saying out loud in a presentation, since they show
scientific honesty rather than cherry-picked success):

1. **HPA+VPA and Reactive Multi-Signal produce numerically identical results**, on every single
   pattern and seed. Widening the signal set to include RAM/connection-pool/backlog, by itself,
   bought nothing in this simulator — CPU and p99 latency dominate the "which signal is most at
   risk" decision regardless of what else is being watched. In other words: **the improvement is
   not coming from watching more signals.**
2. **Forecasting's ≈10% improvement over Reactive Multi-Signal only shows up after the damping
   factor is properly calibrated.** At the originally hand-picked value, the same comparison is
   *not* statistically significant — the benefit of forecasting was there but was being masked by a
   badly-tuned hyperparameter. The calibrated value was selected on 5 of 8 seeds and *confirmed* on
   the 3 held-out seeds never used to pick it (p = 0.014) — which is what makes this a real,
   generalizing effect rather than an artifact of tuning on the test set.

**Forecast accuracy summary** (accuracy = `100 − SMAPE/2`, adaptive blend vs. plain persistence):

| Signal | Accuracy (blend) | Accuracy (persistence) | Notes |
|---|---|---|---|
| RAM | 96.2% (R² = 0.53) | — | Best-forecast signal — smooth, slow dynamics |
| Connection pool | 88.3% | 90.6% | Persistence still wins on raw accuracy |
| p99 latency | 82.3% | 85.9% | Persistence still wins on raw accuracy |
| CPU | 81.6% | 83.2% | Persistence still wins on raw accuracy |

For the two heavy-tailed signals, plain "predict no change" is still the more accurate *point*
forecaster — but the same forecasts still add real value on the *windowed* overload-detection task
(F1 rising from ≈0.16 under the strict framing to 0.36–0.43 under the operationally realistic one).
This is a nuanced, non-triumphalist finding, and it's one of the paper's more interesting results —
"the forecaster isn't very accurate in the traditional sense, but it's still useful for the actual
decision the controller needs to make."

---

## 9. What actually runs, end to end

```
npm run all     # → generates demand traces, runs all 5 controllers × 3 patterns × 8 seeds,
                #   computes all metrics + significance tests, runs the φ/horizon sensitivity sweep
npm start       # → serves a live dashboard at http://localhost:4173 (vanilla canvas charts,
                #   no external dependencies) to visualize any run interactively
```

Code map:

| File | Role |
|---|---|
| `src/engine/systemModel.js` | The closed-loop queueing simulator (§4) |
| `src/engine/forecaster.js` | Holt, persistence, moving-average, linear-drift, and the adaptive blend (§5) |
| `src/engine/controllers.js` | All five controllers (§3.2, §6) |
| `src/engine/simulate.js` | Runs one (controller, workload) simulation |
| `src/engine/runSimulation.js` | Runs the full 5×3×8 grid + statistics (§7) |
| `src/engine/runSensitivity.js` | The φ/horizon calibration + holdout validation (§7.1, §9) |
| `src/engine/metrics.js` | All metric and significance-test implementations |
| `src/server.js`, `src/public/` | The interactive dashboard |
| `paper/main.tex` | The full IEEE-format paper (architecture diagram, equations, all figures) |

---

## 10. Anticipating your teacher's questions

**"Why not just test this on a real Kubernetes cluster?"**
Running dozens of hour-long trials across 5 controllers × 3 patterns × 8 seeds on real
infrastructure would be slow, expensive, and non-reproducible (real cloud traffic isn't
repeatable). A closed-loop simulator makes the comparison deterministic, fast (thousands of
simulated hours run in seconds), and fully inspectable — every constant is visible in the code,
not hidden behind a cloud provider's internals.

**"Isn't forecasting obviously going to win — why even test it this carefully?"**
Because the naive way of testing it (just compare "new fancy controller" vs. "old simple one") is
confounded by everything else that changed at the same time (more signals, different thresholds).
This project's whole methodological contribution is separating "more signals" from "forecasting"
as two independent variables, and it turns out only one of those two actually mattered here.

**"Why does the improvement disappear at the original hyperparameter value?"**
Because `φ` (the trend-damping factor) controls how aggressively the forecaster extrapolates a
trend. Too low, and it barely improves over "assume no change," erasing forecasting's advantage. It
had to be calibrated properly — and, importantly, validated on data *not* used to pick it — before
the benefit could be shown to be real rather than a tuning artifact.

**"What would make this stronger evidence?"**
More workload patterns, more seeds, and eventually validation against a real (not simulated)
deployment — the paper is explicit that the ~10% forecasting benefit is real but modest, and
workload/seed-dependent, rather than a dramatic universal win.

---

## 11. Glossary

- **Replica** — one running copy of the service; more replicas = more capacity.
- **SLO (Service Level Objective)** — a promised performance bound, here p99 latency ≤ 300ms.
- **p99 latency** — the response time that 99% of requests are faster than.
- **Reactive vs. proactive** — acting on the current value of a signal vs. a forecast of its future value.
- **Utilization (ρ)** — demand ÷ capacity; the central quantity in queueing theory.
- **Backlog** — unserved excess demand that accumulates when demand exceeds capacity, and must drain over time.
- **Little's Law** — `L = λW`; the number of items in a system equals arrival rate times time-in-system.
- **Holt's method** — exponential smoothing that tracks both a level and a trend, for forecasting.
- **Damping factor (φ)** — how much a forecast's trend component is discounted per future step, so forecasts converge instead of extrapolating forever.
- **Persistence forecast** — "predict that the future will look like right now."
- **Guardrail** — a safety rule (bounds, cooldown, step limits) that constrains a controller's raw recommendation before it's acted on.
- **Paired t-test** — a statistical test comparing two conditions run on identical inputs, isolating the effect of what actually differs between them.
- **Holdout validation** — checking a calibrated setting on data that played no role in choosing it, to confirm the result generalizes.
