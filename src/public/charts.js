'use strict';
/**
 * Minimal, dependency-free canvas chart library: multi-series line charts
 * (with a crosshair+tooltip hover layer) and grouped bar charts. Colors are
 * passed in by the caller using the fixed categorical order established in
 * app.js (never re-derived here), per the project's charting convention.
 */

function devicePixelSetup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, width: rect.width, height: rect.height };
}

function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step)));
  const norm = step / mag;
  const niceNorm = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  const niceStep = niceNorm * mag;
  const niceMin = Math.floor(min / niceStep) * niceStep;
  const niceMax = Math.ceil(max / niceStep) * niceStep;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + 1e-9; v += niceStep) ticks.push(v);
  return { ticks, min: niceMin, max: niceMax };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts
 * @param {number[]} opts.x - shared x values (e.g. seconds)
 * @param {{label:string, color:string, values:number[], dashed?:boolean}[]} opts.series
 * @param {string} [opts.xLabel]
 * @param {string} [opts.yLabel]
 * @param {{value:number,label:string,color:string}[]} [opts.refLines] - e.g. SLO threshold
 * @param {(v:number)=>string} [opts.yFormat]
 * @param {(v:number)=>string} [opts.xFormat]
 */
function drawLineChart(canvas, opts) {
  const { ctx, width, height } = devicePixelSetup(canvas);
  const style = getComputedStyle(document.documentElement);
  const textPrimary = style.getPropertyValue('--text-primary').trim() || '#0b0b0b';
  const textSecondary = style.getPropertyValue('--text-secondary').trim() || '#52514e';
  const gridColor = style.getPropertyValue('--grid').trim() || 'rgba(128,128,128,0.18)';

  ctx.clearRect(0, 0, width, height);

  const padding = { top: 14, right: 16, bottom: 30, left: 56 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const allValues = opts.series.flatMap((s) => s.values).concat((opts.refLines || []).map((r) => r.value));
  const yMinRaw = Math.min(...allValues);
  const yMaxRaw = Math.max(...allValues);
  const { ticks: yTicks, min: yMin, max: yMax } = niceTicks(Math.min(0, yMinRaw), yMaxRaw, 5);
  const xMin = opts.x[0];
  const xMax = opts.x[opts.x.length - 1];

  const xScale = (v) => padding.left + ((v - xMin) / (xMax - xMin || 1)) * plotW;
  const yScale = (v) => padding.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  // gridlines + y ticks
  ctx.strokeStyle = gridColor;
  ctx.fillStyle = textSecondary;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (const t of yTicks) {
    const y = yScale(t);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
    ctx.stroke();
    ctx.fillText(opts.yFormat ? opts.yFormat(t) : String(Math.round(t)), padding.left - 8, y);
  }

  // x ticks (5 evenly spaced)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTickCount = 6;
  for (let i = 0; i <= xTickCount; i++) {
    const v = xMin + ((xMax - xMin) * i) / xTickCount;
    const x = xScale(v);
    ctx.fillText(opts.xFormat ? opts.xFormat(v) : String(Math.round(v)), x, padding.top + plotH + 8);
  }

  // reference lines (e.g. SLO threshold)
  for (const ref of opts.refLines || []) {
    const y = yScale(ref.value);
    ctx.save();
    ctx.strokeStyle = ref.color;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
    ctx.stroke();
    ctx.restore();
  }

  // series lines
  for (const s of opts.series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(s.dashed ? [4, 3] : []);
    ctx.beginPath();
    opts.x.forEach((xv, i) => {
      const x = xScale(xv);
      const y = yScale(s.values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // axis labels
  if (opts.yLabel) {
    ctx.save();
    ctx.translate(14, padding.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = textSecondary;
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();
  }

  // hover crosshair + tooltip
  const tooltip = canvas.parentElement.querySelector('.chart-tooltip');
  function handleMove(evt) {
    const rect = canvas.getBoundingClientRect();
    const mx = evt.clientX - rect.left;
    if (mx < padding.left || mx > padding.left + plotW) { if (tooltip) tooltip.style.display = 'none'; render(); return; }
    const xv = xMin + ((mx - padding.left) / plotW) * (xMax - xMin);
    let idx = 0, best = Infinity;
    opts.x.forEach((v, i) => { const d = Math.abs(v - xv); if (d < best) { best = d; idx = i; } });
    render(idx);
    if (tooltip) {
      const lines = opts.series.map((s) => `<span style="color:${s.color}">●</span> ${s.label}: <b>${opts.yFormat ? opts.yFormat(s.values[idx]) : s.values[idx].toFixed(1)}</b>`);
      tooltip.innerHTML = `<div class="tt-x">${opts.xFormat ? opts.xFormat(opts.x[idx]) : opts.x[idx]}</div>` + lines.join('<br>');
      tooltip.style.display = 'block';
      const tx = Math.min(width - tooltip.offsetWidth - 8, Math.max(8, mx));
      tooltip.style.left = tx + 'px';
      tooltip.style.top = '8px';
    }
  }
  function render(hoverIdx) {
    ctx.clearRect(0, 0, width, height);
    drawStatic();
    if (hoverIdx != null) {
      const x = xScale(opts.x[hoverIdx]);
      ctx.save();
      ctx.strokeStyle = textSecondary;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, padding.top + plotH);
      ctx.stroke();
      ctx.restore();
      for (const s of opts.series) {
        const y = yScale(s.values[hoverIdx]);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  function drawStatic() {
    ctx.strokeStyle = gridColor;
    ctx.fillStyle = textSecondary;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (const t of yTicks) {
      const y = yScale(t);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotW, y);
      ctx.stroke();
      ctx.fillText(opts.yFormat ? opts.yFormat(t) : String(Math.round(t)), padding.left - 8, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= xTickCount; i++) {
      const v = xMin + ((xMax - xMin) * i) / xTickCount;
      const x = xScale(v);
      ctx.fillText(opts.xFormat ? opts.xFormat(v) : String(Math.round(v)), x, padding.top + plotH + 8);
    }
    for (const ref of opts.refLines || []) {
      const y = yScale(ref.value);
      ctx.save();
      ctx.strokeStyle = ref.color;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotW, y);
      ctx.stroke();
      ctx.restore();
    }
    for (const s of opts.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(s.dashed ? [4, 3] : []);
      ctx.beginPath();
      opts.x.forEach((xv, i) => {
        const x = xScale(xv);
        const y = yScale(s.values[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  canvas.onmousemove = handleMove;
  canvas.onmouseleave = () => { if (tooltip) tooltip.style.display = 'none'; render(); };
}

/**
 * Black-and-white hatch fills for bar charts. Bar charts intentionally avoid
 * hue entirely (unlike the line charts) so they stay legible and cheap to
 * reproduce in grayscale print: identity is carried by fill texture, not
 * color. Assigned in a fixed order, same as the categorical color order used
 * elsewhere, so the same controller always gets the same texture.
 */
const HATCH_TYPES = ['dots', 'diag-right', 'cross', 'solid'];

function drawHatchTile(octx, size, type, fg) {
  octx.clearRect(0, 0, size, size);
  octx.strokeStyle = fg;
  octx.fillStyle = fg;
  octx.lineWidth = 1.1;
  switch (type) {
    case 'solid':
      octx.fillRect(0, 0, size, size);
      break;
    case 'diag-right': // '/'
      octx.beginPath();
      [-1, 0, 1, 2].forEach((k) => {
        octx.moveTo(k * size, size);
        octx.lineTo(k * size + size, 0);
      });
      octx.stroke();
      break;
    case 'diag-left': // '\'
      octx.beginPath();
      [-1, 0, 1, 2].forEach((k) => {
        octx.moveTo(k * size, 0);
        octx.lineTo(k * size + size, size);
      });
      octx.stroke();
      break;
    case 'cross':
      octx.beginPath();
      [-1, 0, 1, 2].forEach((k) => {
        octx.moveTo(k * size, size);
        octx.lineTo(k * size + size, 0);
        octx.moveTo(k * size, 0);
        octx.lineTo(k * size + size, size);
      });
      octx.stroke();
      break;
    case 'dots':
    default:
      octx.beginPath();
      octx.arc(size / 2, size / 2, size * 0.13, 0, Math.PI * 2);
      octx.fill();
      break;
  }
}

/** Build (and cache) a CanvasPattern for a hatch type, themed to the current fg/bg. */
const _patternCache = new Map();
function getHatchPattern(ctx, type, fg, bg) {
  const key = `${type}|${fg}|${bg}`;
  if (_patternCache.has(key)) return _patternCache.get(key);
  const size = 9;
  const off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  const octx = off.getContext('2d');
  octx.fillStyle = bg;
  octx.fillRect(0, 0, size, size);
  drawHatchTile(octx, size, type, fg);
  const pattern = ctx.createPattern(off, 'repeat');
  _patternCache.set(key, pattern);
  return pattern;
}

/** Small standalone swatch (data URL) for HTML legends, matching the canvas hatch exactly. */
function hatchSwatchDataUrl(type, fg, bg, size = 14) {
  const off = document.createElement('canvas');
  off.width = size;
  off.height = size;
  const octx = off.getContext('2d');
  octx.fillStyle = bg;
  octx.fillRect(0, 0, size, size);
  drawHatchTile(octx, size, type, fg);
  return off.toDataURL();
}

function wrapLabel(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Single-measure bar chart: one bar per category, colored by category (color
 * follows the entity, per the project's charting convention), with the
 * category name wrapped directly under its own bar and the value labeled on
 * top. No legend is drawn — the x-axis labels already carry full identity,
 * so a color-key repeating the same names underneath would be redundant.
 * @param {{bars:{label:string,value:number,color:string}[], yLabel?:string, yFormat?:(v:number)=>string}} opts
 */
function drawCategoryBarChart(canvas, opts) {
  const { ctx, width, height } = devicePixelSetup(canvas);
  const style = getComputedStyle(document.documentElement);
  const textPrimary = style.getPropertyValue('--text-primary').trim() || '#0b0b0b';
  const textSecondary = style.getPropertyValue('--text-secondary').trim() || '#52514e';
  const gridColor = style.getPropertyValue('--grid').trim() || 'rgba(128,128,128,0.18)';
  const surface = style.getPropertyValue('--surface-1').trim() || '#ffffff';

  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px system-ui, sans-serif';
  const labelLines = opts.bars.map((b) => wrapLabel(ctx, b.label, 88));
  const maxLines = Math.max(...labelLines.map((l) => l.length));
  const padding = { top: 22, right: 16, bottom: 16 + maxLines * 13, left: 44 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const values = opts.bars.map((b) => b.value);
  const { ticks: yTicks, min: yMin, max: yMax } = niceTicks(0, Math.max(...values, 0.001), 5);
  const yScale = (v) => padding.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  ctx.strokeStyle = gridColor;
  ctx.fillStyle = textSecondary;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (const t of yTicks) {
    const y = yScale(t);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
    ctx.stroke();
    ctx.fillText(opts.yFormat ? opts.yFormat(t) : String(Math.round(t)), padding.left - 8, y);
  }

  const n = opts.bars.length;
  const slotW = plotW / n;
  const barW = Math.min(56, slotW * 0.52);
  const bars = [];

  opts.bars.forEach((b, i) => {
    const hatchType = HATCH_TYPES[i % HATCH_TYPES.length];
    const cx = padding.left + slotW * (i + 0.5);
    const x = cx - barW / 2;
    const y = yScale(b.value);
    const barH = padding.top + plotH - y;
    const r = Math.min(4, barW / 2);
    const barPath = () => {
      ctx.beginPath();
      ctx.moveTo(x, padding.top + plotH);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.lineTo(x + barW - r, y);
      ctx.arcTo(x + barW, y, x + barW, y + r, r);
      ctx.lineTo(x + barW, padding.top + plotH);
      ctx.closePath();
    };
    ctx.fillStyle = getHatchPattern(ctx, hatchType, textPrimary, surface);
    barPath();
    ctx.fill();
    ctx.strokeStyle = textPrimary;
    ctx.lineWidth = 1.3;
    barPath();
    ctx.stroke();
    bars.push({ x, y, w: barW, h: barH, cx, label: b.label, value: b.value, hatchType });

    // value label above the bar
    ctx.fillStyle = textPrimary;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.yFormat ? opts.yFormat(b.value) : b.value.toFixed(1), cx, y - 5);

    // wrapped category label under the axis
    ctx.fillStyle = textSecondary;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    labelLines[i].forEach((line, li) => {
      ctx.fillText(line, cx, padding.top + plotH + 8 + li * 13);
    });
  });

  const tooltip = canvas.parentElement.querySelector('.chart-tooltip');
  canvas.onmousemove = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const mx = evt.clientX - rect.left;
    const my = evt.clientY - rect.top;
    const hit = bars.find((b) => mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= padding.top + plotH);
    if (hit && tooltip) {
      const swatch = hatchSwatchDataUrl(hit.hatchType, textPrimary, surface, 12);
      tooltip.innerHTML = `<img src="${swatch}" style="width:11px;height:11px;vertical-align:-1px;border:1px solid ${textPrimary};margin-right:3px"> ${hit.label}: <b>${opts.yFormat ? opts.yFormat(hit.value) : hit.value.toFixed(2)}</b>`;
      tooltip.style.display = 'block';
      tooltip.style.left = Math.min(width - tooltip.offsetWidth - 8, Math.max(8, mx)) + 'px';
      tooltip.style.top = '4px';
    } else if (tooltip) {
      tooltip.style.display = 'none';
    }
  };
  canvas.onmouseleave = () => { if (tooltip) tooltip.style.display = 'none'; };
}

/**
 * Grouped bar chart for comparing several controllers across 2+ named
 * groups (e.g. churn vs. oscillations). Series color follows the
 * controller/model identity; a legend is appropriate here because color
 * is shared *across* groups rather than being 1:1 with the x-axis labels.
 * @param {{groups:string[], series:{label:string,color:string,values:number[]}[], yFormat?:(v:number)=>string, yLabel?:string}} opts
 */
function drawGroupedBarChart(canvas, opts) {
  const { ctx, width, height } = devicePixelSetup(canvas);
  const style = getComputedStyle(document.documentElement);
  const textPrimary = style.getPropertyValue('--text-primary').trim() || '#0b0b0b';
  const textSecondary = style.getPropertyValue('--text-secondary').trim() || '#52514e';
  const gridColor = style.getPropertyValue('--grid').trim() || 'rgba(128,128,128,0.18)';
  const surface = style.getPropertyValue('--surface-1').trim() || '#ffffff';

  ctx.clearRect(0, 0, width, height);
  const padding = { top: 22, right: 16, bottom: 30, left: 44 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const allValues = opts.series.flatMap((s) => s.values);
  const { ticks: yTicks, min: yMin, max: yMax } = niceTicks(0, Math.max(...allValues, 0.001), 5);
  const yScale = (v) => padding.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  ctx.strokeStyle = gridColor;
  ctx.fillStyle = textSecondary;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (const t of yTicks) {
    const y = yScale(t);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
    ctx.stroke();
    ctx.fillText(opts.yFormat ? opts.yFormat(t) : String(Math.round(t)), padding.left - 8, y);
  }

  const groupCount = opts.groups.length;
  const seriesCount = opts.series.length;
  const groupGutter = 0.22;
  const groupW = plotW / groupCount;
  const clusterW = groupW * (1 - groupGutter * 2);
  const barGap = 3;
  const barW = (clusterW - barGap * (seriesCount - 1)) / seriesCount;

  const bars = [];
  opts.groups.forEach((g, gi) => {
    const clusterX = padding.left + gi * groupW + groupW * groupGutter;
    opts.series.forEach((s, si) => {
      const hatchType = HATCH_TYPES[si % HATCH_TYPES.length];
      const val = s.values[gi];
      const x = clusterX + si * (barW + barGap);
      const y = yScale(val);
      const barH = padding.top + plotH - y;
      const r = Math.min(3, barW / 2);
      const barPath = () => {
        ctx.beginPath();
        ctx.moveTo(x, padding.top + plotH);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.lineTo(x + barW - r, y);
        ctx.arcTo(x + barW, y, x + barW, y + r, r);
        ctx.lineTo(x + barW, padding.top + plotH);
        ctx.closePath();
      };
      ctx.fillStyle = getHatchPattern(ctx, hatchType, textPrimary, surface);
      barPath();
      ctx.fill();
      ctx.strokeStyle = textPrimary;
      ctx.lineWidth = 1.1;
      barPath();
      ctx.stroke();
      bars.push({ x, y, w: barW, h: barH, label: s.label, value: val, group: g, hatchType });
    });
    ctx.fillStyle = textSecondary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(g, clusterX + clusterW / 2, padding.top + plotH + 8);
  });

  const tooltip = canvas.parentElement.querySelector('.chart-tooltip');
  canvas.onmousemove = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const mx = evt.clientX - rect.left;
    const my = evt.clientY - rect.top;
    const hit = bars.find((b) => mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= padding.top + plotH);
    if (hit && tooltip) {
      const swatch = hatchSwatchDataUrl(hit.hatchType, textPrimary, surface, 12);
      tooltip.innerHTML = `<div class="tt-x">${hit.group}</div><img src="${swatch}" style="width:11px;height:11px;vertical-align:-1px;border:1px solid ${textPrimary};margin-right:3px"> ${hit.label}: <b>${opts.yFormat ? opts.yFormat(hit.value) : hit.value.toFixed(2)}</b>`;
      tooltip.style.display = 'block';
      tooltip.style.left = Math.min(width - tooltip.offsetWidth - 8, Math.max(8, mx)) + 'px';
      tooltip.style.top = '4px';
    } else if (tooltip) {
      tooltip.style.display = 'none';
    }
  };
  canvas.onmouseleave = () => { if (tooltip) tooltip.style.display = 'none'; };
}

window.ProChart = { drawLineChart, drawCategoryBarChart, drawGroupedBarChart, hatchSwatchDataUrl, HATCH_TYPES };
