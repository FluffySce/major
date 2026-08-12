#!/usr/bin/env python3
"""Render publication figures for the LaTeX paper from the Node.js simulation
results (results/summary.json, results/sensitivity.json,
results/timeseries/*.json). Run inside the project venv:
.venv/bin/python scripts/make_figures.py
"""
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "results")
FIG_DIR = os.path.join(ROOT, "paper", "figures")
os.makedirs(FIG_DIR, exist_ok=True)

plt.rcParams.update({
    "font.size": 9,
    "axes.titlesize": 10,
    "axes.labelsize": 9,
    "legend.fontsize": 8,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
    "axes.edgecolor": "#8a8a86",
    "axes.linewidth": 0.8,
    "grid.color": "#d8d6d0",
    "grid.linewidth": 0.6,
    "figure.dpi": 200,
    "savefig.dpi": 300,
    "savefig.bbox": "tight",
    "font.family": "DejaVu Sans",
    "hatch.linewidth": 0.9,
})

CONTROLLERS = [
    ("default_hpa", "Default HPA", "#2a78d6"),
    ("tuned_hpa", "Tuned HPA", "#eb6834"),
    ("hpa_vpa", "HPA+VPA", "#1baf7a"),
    ("reactive_multi_signal", "Reactive Multi-Signal", "#7a52c9"),
    ("proactive", "Proactive (proposed)", "#b8860b"),
]
SLO_COLOR = "#c23a39"

# Bar charts are deliberately colorless: black/white hatch fills only, so
# they stay legible and cheap to reproduce in a grayscale print run. Only
# the time-series line plots (fig_timeseries) keep the categorical palette.
BW_STYLES = [
    {"facecolor": "white", "edgecolor": "black", "hatch": "...."},
    {"facecolor": "white", "edgecolor": "black", "hatch": "////"},
    {"facecolor": "white", "edgecolor": "black", "hatch": "xxxx"},
    {"facecolor": "white", "edgecolor": "black", "hatch": "\\\\\\\\"},
    {"facecolor": "black", "edgecolor": "black", "hatch": ""},
]


def bar_with_style(ax, x, vals, style, width, **kwargs):
    return ax.bar(x, vals, width=width, facecolor=style["facecolor"], edgecolor=style["edgecolor"],
                   hatch=style["hatch"], linewidth=0.9, zorder=3, **kwargs)


def load_summary():
    with open(os.path.join(RESULTS, "summary.json")) as f:
        return json.load(f)


def load_sensitivity():
    path = os.path.join(RESULTS, "sensitivity.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def load_timeseries(pattern, controller):
    with open(os.path.join(RESULTS, "timeseries", f"{pattern}__{controller}.json")) as f:
        return json.load(f)


def style_axes(ax):
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.grid(axis="y", zorder=0)
    ax.set_axisbelow(True)


def legend_above(ax, ncol=2, fontsize=None):
    """Place the legend outside the plot (above it), so it can never overlap
    bars/lines regardless of data height -- unlike loc='best', which picked
    a corner still covered by a tall bar in some of these charts."""
    kwargs = {"fontsize": fontsize} if fontsize else {}
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.02), ncol=ncol,
               frameon=False, borderaxespad=0, **kwargs)


def fig_timeseries(pattern="bursty"):
    runs = {cid: load_timeseries(pattern, cid) for cid, _, _ in CONTROLLERS}
    tmin = np.array([p["t"] for p in runs["default_hpa"]["timeseries"]]) / 60.0

    fig, axes = plt.subplots(3, 1, figsize=(6.6, 8.0), sharex=True)

    demand = [p["demandRps"] for p in runs["default_hpa"]["timeseries"]]
    axes[0].plot(tmin, demand, color="#52514e", linewidth=1.1)
    axes[0].set_ylabel("Demand (rps)")
    axes[0].set_title(f"Workload: {pattern.replace('_',' ')}", loc="left", fontweight="bold")
    style_axes(axes[0])

    for cid, label, color in CONTROLLERS:
        vals = [p["replicas"] for p in runs[cid]["timeseries"]]
        axes[1].plot(tmin, vals, color=color, linewidth=1.2, label=label)
    axes[1].set_ylabel("Replicas")
    legend_above(axes[1], ncol=3, fontsize=7.5)
    style_axes(axes[1])

    for cid, label, color in CONTROLLERS:
        vals = [min(p["p99"], 2000) for p in runs[cid]["timeseries"]]  # clip for readability
        axes[2].plot(tmin, vals, color=color, linewidth=1.1, label=label)
    axes[2].axhline(300, color=SLO_COLOR, linestyle="--", linewidth=1.2, label="SLO (300 ms)")
    axes[2].set_ylabel("p99 latency (ms, clipped at 2000)")
    axes[2].set_xlabel("Time (minutes)")
    legend_above(axes[2], ncol=3, fontsize=7)
    style_axes(axes[2])

    fig.tight_layout(rect=[0, 0, 1, 1])
    fig.savefig(os.path.join(FIG_DIR, f"timeseries_{pattern}.png"))
    plt.close(fig)


def fig_bar_comparison(summary):
    agg = {a["controller"]: a for a in summary["aggregate"]}
    labels = [label for _, label, _ in CONTROLLERS]
    n = len(CONTROLLERS)

    metrics = [
        ("avgSloViolationDurationSeconds", "SLO violation duration (s)", "slo_duration", "{:.0f}"),
        ("avgNodeHours", "Avg. node-hours", "cost", "{:.2f}"),
        ("avgTimeToScaleSeconds", "Time-to-scale (s)", "time_to_scale", "{:.0f}"),
    ]
    for key, ylabel, fname, fmt in metrics:
        fig, ax = plt.subplots(figsize=(4.8, 3.0))
        vals = [agg[cid][key] for cid, _, _ in CONTROLLERS]
        for i, (x, v) in enumerate(zip(range(n), vals)):
            bar_with_style(ax, x, [v], BW_STYLES[i % len(BW_STYLES)], width=0.6)
            ax.annotate(fmt.format(v), (x, v), ha="center", va="bottom", fontsize=7.5)
        ax.set_xticks(range(n))
        ax.set_xticklabels(labels)
        ax.set_ylabel(ylabel)
        ax.margins(y=0.12)
        style_axes(ax)
        plt.setp(ax.get_xticklabels(), rotation=18, ha="right")
        fig.tight_layout()
        fig.savefig(os.path.join(FIG_DIR, f"bar_{fname}.png"))
        plt.close(fig)

    fig, ax = plt.subplots(figsize=(5.0, 3.0))
    x = np.arange(n)
    w = 0.35
    churn = [agg[cid]["avgChurnPerHour"] for cid, _, _ in CONTROLLERS]
    osc = [agg[cid]["avgOscillationsPerHour"] for cid, _, _ in CONTROLLERS]
    bar_with_style(ax, x - w / 2, churn, BW_STYLES[1], width=w, label="Churn / hr")
    bar_with_style(ax, x + w / 2, osc, BW_STYLES[3], width=w, label="Oscillations / hr")
    ax.set_xticks(x)
    ax.set_xticklabels(labels, rotation=18, ha="right")
    ax.set_ylabel("Events / hour")
    legend_above(ax)
    style_axes(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG_DIR, "bar_stability.png"))
    plt.close(fig)


def fig_multiseed(summary):
    """SLO violation duration, mean +/- std across all (pattern, seed)
    replicates -- the statistically-robust counterpart to the single-run
    bar_slo_duration.png figure."""
    stats = {m["controller"]: m for m in summary["multiSeedStats"]}
    labels = [label for _, label, _ in CONTROLLERS]
    n = len(CONTROLLERS)
    means = [stats[cid]["sloViolationDurationSeconds"]["mean"] for cid, _, _ in CONTROLLERS]
    stds = [stats[cid]["sloViolationDurationSeconds"]["std"] for cid, _, _ in CONTROLLERS]
    n_samples = stats[CONTROLLERS[0][0]]["sloViolationDurationSeconds"]["n"]

    fig, ax = plt.subplots(figsize=(5.0, 3.2))
    x = np.arange(n)
    for i in range(n):
        bar_with_style(ax, x[i], [means[i]], BW_STYLES[i % len(BW_STYLES)], width=0.6)
    ax.errorbar(x, means, yerr=stds, fmt="none", ecolor="black", elinewidth=1.1, capsize=4, zorder=4)
    for i, (m, s) in enumerate(zip(means, stds)):
        ax.annotate(f"{m:.0f}", (i, m + s), ha="center", va="bottom", fontsize=7.5)
    ax.set_xticks(x)
    ax.set_xticklabels(labels, rotation=18, ha="right")
    ax.set_ylabel("SLO violation duration (s)")
    ax.set_title(f"Mean $\\pm$ 1 std.\\ across {n_samples} (pattern, seed) replicates", loc="left", fontsize=8.5)
    ax.margins(y=0.15)
    style_axes(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG_DIR, "bar_multiseed_slo.png"))
    plt.close(fig)


def fig_sensitivity(sens):
    if sens is None:
        return
    # Phi sweep
    phis = [r["phi"] for r in sens["phiSweep"]]
    means = [r["sloDuration"]["mean"] for r in sens["phiSweep"]]
    stds = [r["sloDuration"]["std"] for r in sens["phiSweep"]]
    baseline = sens["reactiveMultiSignalBaselineTune"]["mean"]

    fig, ax = plt.subplots(figsize=(5.2, 3.2))
    ax.errorbar(phis, means, yerr=stds, fmt="o-", color="#b8860b", ecolor="#b8860b",
                elinewidth=1.0, capsize=3, markersize=4, zorder=3, label="Proactive (tune seeds)")
    ax.axhline(baseline, color="#7a52c9", linestyle="--", linewidth=1.2, label="Reactive Multi-Signal (tune seeds)")
    ax.axvline(0.97, color="#8a8a86", linestyle=":", linewidth=1.0)
    ax.annotate("calibrated\n$\\phi=0.97$", (0.97, max(means) * 0.98), fontsize=7, ha="right", color="#52514e")
    ax.set_xlabel("Damping factor $\\phi$")
    ax.set_ylabel("SLO violation duration (s)")
    legend_above(ax, ncol=2, fontsize=7.5)
    style_axes(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG_DIR, "sensitivity_phi.png"))
    plt.close(fig)

    # Horizon sweep
    hs = [r["horizonS"] for r in sens["horizonSweep"]]
    hmeans = [r["sloDuration"]["mean"] for r in sens["horizonSweep"]]
    hstds = [r["sloDuration"]["std"] for r in sens["horizonSweep"]]

    fig, ax = plt.subplots(figsize=(5.2, 3.2))
    ax.errorbar(hs, hmeans, yerr=hstds, fmt="o-", color="#b8860b", ecolor="#b8860b",
                elinewidth=1.0, capsize=3, markersize=4, zorder=3, label="Proactive (tune seeds, $\\phi=$ default)")
    ax.axhline(baseline, color="#7a52c9", linestyle="--", linewidth=1.2, label="Reactive Multi-Signal (tune seeds)")
    ax.axvline(45, color="#8a8a86", linestyle=":", linewidth=1.0)
    ax.set_xlabel("Forecast horizon $h$ (s)")
    ax.set_ylabel("SLO violation duration (s)")
    legend_above(ax, ncol=1, fontsize=7.5)
    style_axes(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG_DIR, "sensitivity_horizon.png"))
    plt.close(fig)


def fig_forecast_accuracy(summary):
    signals = [("p99", "p99 latency"), ("cpu", "CPU"), ("ram", "RAM"), ("pool", "Conn. pool")]
    variants = [
        ("model", "Adaptive blend (proposed)"),
        ("holtOnly", "Holt only"),
        ("persistence", "Persistence"),
        ("movingAverage", "Moving avg."),
        ("linearDrift", "Linear drift"),
    ]
    fig, ax = plt.subplots(figsize=(6.6, 3.6))
    n = len(signals)
    k = len(variants)
    w = 0.8 / k
    x = np.arange(n)
    for i, (vkey, vlabel) in enumerate(variants):
        vals = [summary["forecastSummary"][sk][vkey]["accuracyPct"] for sk, _ in signals]
        bars = bar_with_style(ax, x + (i - (k - 1) / 2) * w, vals, BW_STYLES[i % len(BW_STYLES)], width=w, label=vlabel)
        for xi, v in zip(x, vals):
            ax.annotate(f"{v:.0f}", (xi + (i - (k - 1) / 2) * w, v), ha="center", va="bottom", fontsize=6.2)
    ax.set_xticks(x)
    ax.set_xticklabels([s[1] for s in signals])
    ax.set_ylabel("Forecast accuracy (100 - SMAPE/2, %)")
    ax.set_ylim(0, 105)
    legend_above(ax, ncol=3, fontsize=7)
    style_axes(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG_DIR, "forecast_accuracy.png"))
    plt.close(fig)


def fig_classification(summary):
    cats = ["Precision", "Recall", "F1", "Accuracy"]

    def make(cls_summary, fname, subtitle):
        holt = [cls_summary["holt"][k.lower()] * 100 for k in cats]
        pers = [cls_summary["persistence"][k.lower()] * 100 for k in cats]
        fig, ax = plt.subplots(figsize=(5.0, 3.05))
        x = np.arange(len(cats))
        w = 0.35
        bar_with_style(ax, x - w / 2, holt, BW_STYLES[4], width=w, label="Adaptive-blend forecaster")
        bar_with_style(ax, x + w / 2, pers, BW_STYLES[1], width=w, label="Naive persistence")
        ax.set_xticks(x)
        ax.set_xticklabels(cats)
        ax.set_ylabel("%")
        legend_above(ax)
        style_axes(ax)
        fig.suptitle(subtitle, x=0.02, y=1.06, ha="left", fontsize=8)
        fig.tight_layout(rect=[0, 0, 1, 0.90])
        fig.savefig(os.path.join(FIG_DIR, fname))
        plt.close(fig)

    make(summary["classificationSummary"], "classification_metrics.png",
         "Point-in-time: breach at exactly $t+h$?")
    make(summary["classificationSummaryWindowed"], "classification_metrics_windowed.png",
         "Windowed: breach at any point in $(t, t+h]$?")


def fig_slo_by_pattern(summary):
    patterns = ["bursty", "queue_driven", "mixed"]
    n = len(CONTROLLERS)
    fig, ax = plt.subplots(figsize=(6.6, 3.4))
    x = np.arange(len(patterns))
    w = 0.8 / n
    by_pc = {(r["pattern"], r["controller"]): r for r in summary["runs"]}
    for i, (cid, label, color) in enumerate(CONTROLLERS):
        vals = [by_pc[(p, cid)]["metrics"]["slo"]["durationSeconds"] for p in patterns]
        bar_with_style(ax, x + (i - (n - 1) / 2) * w, vals, BW_STYLES[i % len(BW_STYLES)], width=w, label=label)
    ax.set_xticks(x)
    ax.set_xticklabels(["Bursty", "Queue-driven", "Mixed"])
    ax.set_ylabel("SLO violation duration (s)")
    legend_above(ax, ncol=3, fontsize=7)
    style_axes(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG_DIR, "slo_by_pattern.png"))
    plt.close(fig)


def main():
    summary = load_summary()
    sens = load_sensitivity()
    for pattern in ["bursty", "queue_driven", "mixed"]:
        fig_timeseries(pattern)
    fig_bar_comparison(summary)
    fig_multiseed(summary)
    fig_sensitivity(sens)
    fig_forecast_accuracy(summary)
    fig_classification(summary)
    fig_slo_by_pattern(summary)
    print(f"wrote figures to {FIG_DIR}")


if __name__ == "__main__":
    main()
