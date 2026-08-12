'use strict';
/**
 * Runs one closed-loop simulation: a single controller against a single
 * demand trace, at 1s resolution, with the controller re-evaluated every
 * `controlIntervalS` seconds (default 15s, matching Kubernetes' default
 * HPA sync period so all controllers are compared on equal footing).
 */
const { SystemModel } = require('./systemModel');

const CONTROL_INTERVAL_S = 15;
const INITIAL_REPLICAS = 4;

function runSimulation(demandTrace, ControllerClass, opts = {}) {
  const controlIntervalS = opts.controlIntervalS ?? CONTROL_INTERVAL_S;
  const model = new SystemModel({ seed: opts.seed ?? 7, initialReplicas: INITIAL_REPLICAS });
  const controller = new ControllerClass({ ...opts, controlIntervalS, horizonS: opts.horizonS ?? 30 });
  controller.lastReplicas = INITIAL_REPLICAS;

  const timeseries = [];
  let lastDesired = INITIAL_REPLICAS;

  for (const point of demandTrace.points) {
    const snapshot = model.step(point.rps, demandTrace.dt);

    if (typeof controller.observe === 'function') {
      controller.observe(snapshot.t, snapshot);
    }

    if (snapshot.t % controlIntervalS === 0) {
      const { desiredReplicas, meta } = controller.decide(snapshot.t, snapshot);
      lastDesired = desiredReplicas;
      model.requestReplicas(desiredReplicas);
      timeseries.push({ ...snapshot, action: true, desiredReplicas, meta });
    } else {
      timeseries.push({ ...snapshot, action: false, desiredReplicas: lastDesired });
    }
  }

  return {
    controller: controller.name,
    pattern: demandTrace.pattern,
    controlIntervalS,
    timeseries,
    predictionLog: controller.predictionLog || null,
  };
}

module.exports = { runSimulation, CONTROL_INTERVAL_S, INITIAL_REPLICAS };
