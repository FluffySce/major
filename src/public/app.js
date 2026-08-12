'use strict';

const CONTROLLERS = [
  { id: 'default_hpa', label: 'Default HPA', colorVar: '--series-1' },
  { id: 'tuned_hpa', label: 'Tuned HPA', colorVar: '--series-2' },
  { id: 'hpa_vpa', label: 'HPA + VPA', colorVar: '--series-3' },
  { id: 'reactive_multi_signal', label: 'Reactive Multi-Signal', colorVar: '--series-4' },
  { id: 'proactive', label: 'Proactive (proposed)', colorVar: '--series-5' },
];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtPct(v) { return v == null || Number.isNaN(v) ? '—' : `${v.toFixed(1)}%`; }
function fmtNum(v, d = 1) { return v == null || Number.isNaN(v) ? '—' : v.toFixed(d); }

function legendHtml(items) {
  return `<div class="legend">${items.map((i) => `<span><span class="dot" style="background:${i.color}"></span>${i.label}</span>`).join('')}</div>`;
}

function chartCard(id, title, sub) {
  return `<div class="card">
    <h3>${title}</h3>
    <div class="chart-wrap"><canvas id="${id}"></canvas><div class="chart-tooltip"></div></div>
    ${sub || ''}
  </div>`;
}

let currentPattern = 'bursty';
let summaryCache = null;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function loadPattern(pattern) {
  const grid = document.getElementById('timeseriesGrid');
  grid.innerHTML = [
    chartCard('chartDemand', 'Request demand (rps)', legendHtml([{ color: cssVar('--text-secondary'), label: 'Demand (input, identical across controllers)' }])),
    chartCard('chartReplicas', 'Replica count', legendHtml(CONTROLLERS.map((c) => ({ color: cssVar(c.colorVar), label: c.label })))),
    chartCard('chartP99', 'p99 latency (ms) vs. 300ms SLO', legendHtml(CONTROLLERS.map((c) => ({ color: cssVar(c.colorVar), label: c.label })).concat([{ color: cssVar('--status-critical'), label: 'SLO threshold' }]))),
    chartCard('chartCpu', 'CPU utilization (%)', legendHtml(CONTROLLERS.map((c) => ({ color: cssVar(c.colorVar), label: c.label })))),
    chartCard('chartRam', 'RAM utilization (%)', legendHtml(CONTROLLERS.map((c) => ({ color: cssVar(c.colorVar), label: c.label })))),
    chartCard('chartPool', 'Connection-pool utilization (%)', legendHtml(CONTROLLERS.map((c) => ({ color: cssVar(c.colorVar), label: c.label })))),
  ].join('');

  const runs = await Promise.all(CONTROLLERS.map((c) => fetchJson(`/api/timeseries/${pattern}/${c.id}`)));
  const x = runs[0].timeseries.map((s) => s.t);

  window.ProChart.drawLineChart(document.getElementById('chartDemand'), {
    x, series: [{ label: 'Demand', color: cssVar('--text-secondary'), values: runs[0].timeseries.map((s) => s.demandRps) }],
    yLabel: 'rps', xFormat: (v) => `${Math.round(v / 60)}m`,
  });

  window.ProChart.drawLineChart(document.getElementById('chartReplicas'), {
    x, series: CONTROLLERS.map((c, i) => ({ label: c.label, color: cssVar(c.colorVar), values: runs[i].timeseries.map((s) => s.replicas) })),
    yLabel: 'replicas', xFormat: (v) => `${Math.round(v / 60)}m`,
  });

  window.ProChart.drawLineChart(document.getElementById('chartP99'), {
    x, series: CONTROLLERS.map((c, i) => ({ label: c.label, color: cssVar(c.colorVar), values: runs[i].timeseries.map((s) => s.p99) })),
    refLines: [{ value: 300, label: 'SLO', color: cssVar('--status-critical') }],
    yLabel: 'ms', xFormat: (v) => `${Math.round(v / 60)}m`, yFormat: (v) => v.toFixed(0),
  });

  window.ProChart.drawLineChart(document.getElementById('chartCpu'), {
    x, series: CONTROLLERS.map((c, i) => ({ label: c.label, color: cssVar(c.colorVar), values: runs[i].timeseries.map((s) => s.cpu) })),
    yLabel: '%', xFormat: (v) => `${Math.round(v / 60)}m`,
  });

  window.ProChart.drawLineChart(document.getElementById('chartRam'), {
    x, series: CONTROLLERS.map((c, i) => ({ label: c.label, color: cssVar(c.colorVar), values: runs[i].timeseries.map((s) => s.ram) })),
    yLabel: '%', xFormat: (v) => `${Math.round(v / 60)}m`,
  });

  window.ProChart.drawLineChart(document.getElementById('chartPool'), {
    x, series: CONTROLLERS.map((c, i) => ({ label: c.label, color: cssVar(c.colorVar), values: runs[i].timeseries.map((s) => s.connPoolUtil) })),
    yLabel: '%', xFormat: (v) => `${Math.round(v / 60)}m`,
  });
}

/**
 * Bar charts are deliberately colorless (black/white hatch fills only, see
 * charts.js) so they stay legible and cheap to reproduce in grayscale print;
 * only the line charts above use the categorical color palette.
 */
function hatchLegendHtml(labels) {
  const fg = cssVar('--text-primary');
  const bg = cssVar('--surface-1');
  const items = labels.map((label, i) => {
    const type = window.ProChart.HATCH_TYPES[i % window.ProChart.HATCH_TYPES.length];
    const swatch = window.ProChart.hatchSwatchDataUrl(type, fg, bg, 14);
    return `<span><img src="${swatch}" style="width:12px;height:12px;vertical-align:-2px;border:1px solid ${fg};margin-right:5px">${label}</span>`;
  });
  return `<div class="legend">${items.join('')}</div>`;
}

function renderComparison(summary) {
  const grid = document.getElementById('comparisonGrid');
  grid.innerHTML = [
    chartCard('barSloDur', 'SLO violation duration (s, lower is better)'),
    chartCard('barCost', 'Avg. node-hours (cost proxy, lower is better)'),
    chartCard('barT2s', 'Avg. time-to-scale (s, lower is better)'),
    chartCard('barStability', 'Scaling churn & oscillations per hour (lower is better)', hatchLegendHtml(CONTROLLERS.map((c) => c.label))),
  ].join('');

  const order = CONTROLLERS.map((c) => summary.aggregate.find((a) => a.controller === c.id));

  window.ProChart.drawCategoryBarChart(document.getElementById('barSloDur'), {
    bars: CONTROLLERS.map((c, i) => ({ label: c.label, value: order[i].avgSloViolationDurationSeconds })),
    yFormat: (v) => v.toFixed(0),
  });

  window.ProChart.drawCategoryBarChart(document.getElementById('barCost'), {
    bars: CONTROLLERS.map((c, i) => ({ label: c.label, value: order[i].avgNodeHours })),
    yFormat: (v) => v.toFixed(2),
  });

  window.ProChart.drawCategoryBarChart(document.getElementById('barT2s'), {
    bars: CONTROLLERS.map((c, i) => ({ label: c.label, value: order[i].avgTimeToScaleSeconds })),
    yFormat: (v) => v.toFixed(0),
  });

  window.ProChart.drawGroupedBarChart(document.getElementById('barStability'), {
    groups: ['Churn / hr', 'Oscillations / hr'],
    series: CONTROLLERS.map((c, i) => ({ label: c.label, values: [order[i].avgChurnPerHour, order[i].avgOscillationsPerHour] })),
    yLabel: 'events/hr',
  });
}

function renderForecastTable(summary) {
  const signals = [
    { key: 'p99', label: 'p99 latency' },
    { key: 'cpu', label: 'CPU utilization' },
    { key: 'ram', label: 'RAM utilization' },
    { key: 'pool', label: 'Connection-pool utilization' },
  ];
  const rows = signals.map((s) => {
    const f = summary.forecastSummary[s.key];
    const modelWins = f.model.accuracyPct >= f.persistence.accuracyPct;
    return `<tr>
      <td>${s.label}</td>
      <td class="num">${fmtPct(f.model.accuracyPct)} <span class="pill ${modelWins ? 'good' : 'bad'}">${modelWins ? 'Blend ▲' : 'Persistence ▲'}</span></td>
      <td class="num">${fmtPct(f.persistence.accuracyPct)}</td>
      <td class="num">${fmtNum(f.model.rmse, 2)}</td>
      <td class="num">${fmtNum(f.persistence.rmse, 2)}</td>
      <td class="num">${fmtNum(f.model.r2, 3)}</td>
      <td class="num">${fmtNum(f.persistence.r2, 3)}</td>
    </tr>`;
  }).join('');
  document.getElementById('forecastTableWrap').innerHTML = `
    <table>
      <thead><tr><th>Signal</th><th class="num">Adaptive blend accuracy (100−SMAPE/2)</th><th class="num">Persistence accuracy</th><th class="num">Blend RMSE</th><th class="num">Persistence RMSE</th><th class="num">Blend R²</th><th class="num">Persistence R²</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderClassTable(summary) {
  const rows = ['holt', 'persistence'].map((k) => {
    const c = summary.classificationSummary[k];
    return `<tr>
      <td>${k === 'holt' ? 'Adaptive blend forecaster' : 'Naive persistence baseline'}</td>
      <td class="num">${fmtPct((c.precision || 0) * 100)}</td>
      <td class="num">${fmtPct((c.recall || 0) * 100)}</td>
      <td class="num">${fmtPct((c.f1 || 0) * 100)}</td>
      <td class="num">${fmtPct((c.accuracy || 0) * 100)}</td>
    </tr>`;
  }).join('');
  document.getElementById('classTableWrap').innerHTML = `
    <table>
      <thead><tr><th>Model</th><th class="num">Precision</th><th class="num">Recall</th><th class="num">F1</th><th class="num">Accuracy</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function main() {
  document.querySelectorAll('#patternTabs button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('#patternTabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentPattern = btn.dataset.pattern;
      await loadPattern(currentPattern);
    });
  });

  summaryCache = await fetchJson('/api/summary');
  renderComparison(summaryCache);
  renderForecastTable(summaryCache);
  renderClassTable(summaryCache);
  await loadPattern(currentPattern);

  window.addEventListener('resize', () => { loadPattern(currentPattern); renderComparison(summaryCache); });
}

main().catch((err) => {
  document.querySelector('main').innerHTML = `<p style="color:red">Failed to load: ${err.message}. Did you run <code>npm run all</code>?</p>`;
  console.error(err);
});
