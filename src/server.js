'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const RESULTS_DIR = path.join(__dirname, '..', 'results');
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.static(PUBLIC_DIR));

app.get('/api/summary', (req, res) => {
  const file = path.join(RESULTS_DIR, 'summary.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'run `npm run simulate` first' });
  res.type('application/json').send(fs.readFileSync(file, 'utf8'));
});

app.get('/api/timeseries/:pattern/:controller', (req, res) => {
  const { pattern, controller } = req.params;
  const safe = /^[a-z0-9_]+$/i;
  if (!safe.test(pattern) || !safe.test(controller)) return res.status(400).json({ error: 'invalid params' });
  const file = path.join(RESULTS_DIR, 'timeseries', `${pattern}__${controller}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  res.type('application/json').send(fs.readFileSync(file, 'utf8'));
});

const PORT = process.env.PORT || 4173;
app.listen(PORT, () => {
  console.log(`Proactive autoscaler dashboard: http://localhost:${PORT}`);
});
