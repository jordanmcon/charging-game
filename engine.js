/* Station Tycoon v3 — deterministic simulation engine.
 * Pure logic, no DOM. Loads in the browser (window.StationEngine) and in
 * Node (module.exports) so the server can recompute any submitted score
 * from (config, scenario) and never trust the client.
 *
 * Determinism contract: every random draw flows through a seeded PRNG
 * derived from (scenario.id, dayIndex). Same config + scenario => same
 * score, on any platform, forever. Do not call Math.random() anywhere.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
  else { root.StationEngine = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '3.1.0';
  var TICKS_PER_DAY = 1440;            // 1 tick = 1 minute
  var BATT = { capKWh: 380, disKW: 250, chgKW: 150, cost: 150000 };
  var CAB  = { kw: 800, cost: 100000, portsPer: 6 };
  var PORT = { fixed: 30000, perKW: 150 };
  var AMORT_DAYS = 3650;               // 10-year straight-line
  var QUEUE_MAX = 5;
  var HAPPY_THRESHOLD = 0.9;           // avg (delivered/asked) per session
  var SCORE_HAPPINESS_EXP = 2;         // score = profit * (happiness)^2 when profitable

  /* ---------- seeded PRNG (xmur3 hash -> mulberry32 stream) ---------- */
  function xmur3(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rngFor(scenarioId, day) {
    return mulberry32(xmur3(String(scenarioId) + '::day' + day)());
  }

  /* ---------- domain model ---------- */
  function arrivalRate(h) {
    if (h < 6)  return 1.2;
    if (h < 9)  return 7 + (h - 6) * 1.5;
    if (h < 15) return 6;
    if (h < 19) return 9 + (h >= 16 && h < 18 ? 3 : 0);
    if (h < 22) return 5;
    return 2;
  }

  function newCar(rnd) {
    var r = rnd(), P, E, ty;
    if (r < 0.12)      { P = 55 + rnd() * 25;   E = 58 + rnd() * 8;   ty = 'Legacy'; }
    else if (r < 0.67) { P = 150 + rnd() * 100; E = 72 + rnd() * 10;  ty = 'Mainstream'; }
    else if (r < 0.92) { P = 230 + rnd() * 120; E = 78 + rnd() * 22;  ty = '800V'; }
    else               { P = 300 + rnd() * 100; E = 100 + rnd() * 30; ty = 'Truck/lux'; }
    return {
      P: Math.round(P), E: E, ty: ty,
      soc: 0.08 + rnd() * 0.32,
      tgt: 0.8 + rnd() * 0.15,
      ratioSum: 0, ticks: 0
    };
  }

  function powerCurve(car) {
    var s = car.soc;
    if (s < 0.45) return car.P;
    if (s < 0.8)  return car.P * (1 - 0.6 * (s - 0.45) / 0.35);
    return Math.max(car.P * 0.12, car.P * (0.4 - 0.28 * (s - 0.8) / 0.2));
  }

  /* ---------- config validation (server runs this too) ---------- */
  function validateConfig(cfg, scenario) {
    function step50(x) { return Math.round(x / 50) * 50; }
    var c = {
      ports:     Math.max(2, Math.min(12, Math.round(Number(cfg.ports)))),
      portKW:    Math.max(100, Math.min(400, step50(Number(cfg.portKW)))),
      drawLimit: Math.max(100, Math.min(scenario.gridKW, step50(Number(cfg.drawLimit)))),
      battery:   !!cfg.battery,
      price:     Math.max(0.30, Math.min(0.75, Math.round(Number(cfg.price) * 100) / 100))
    };
    for (var k in c) {
      if (typeof c[k] === 'number' && !isFinite(c[k])) {
        throw new Error('Invalid config value for ' + k);
      }
    }
    return c;
  }

  function nCabinets(cfg) { return Math.ceil(cfg.ports / CAB.portsPer); }

  function capexDaily(cfg) {
    return (cfg.ports * (PORT.fixed + PORT.perKW * cfg.portKW)
          + nCabinets(cfg) * CAB.cost
          + (cfg.battery ? BATT.cost : 0)) / AMORT_DAYS;
  }

  /* ---------- simulation ---------- */
  function createSim(cfg, scenario, day) {
    cfg = validateConfig(cfg, scenario);
    var rnd = rngFor(scenario.id, day);
    var S = {
      t: 0, day: day,
      cars: new Array(cfg.ports).fill(null),
      q: [],
      soc: cfg.battery ? BATT.capKWh * 0.5 : 0,
      kwhSold: 0, kwhGrid: 0,
      winE: 0, billPeak: 0,
      served: 0, balked: 0, reneged: 0, happy: 0, completed: 0,
      gridNow: 0, cabLoad: []
    };

    function tick() {
      if (S.t >= TICKS_PER_DAY) return false;
      S.t++;
      var h = S.t / 60;
      var demandMult = Math.min(2.0, Math.max(0.3, Math.pow(0.45 / cfg.price, 1.4)))
                     * (scenario.arrivalScale || 1);
      if (rnd() < arrivalRate(h) * demandMult / 60) {
        var free = S.cars.findIndex(function (c) { return !c; });
        if (free >= 0) { S.cars[free] = newCar(rnd); S.served++; }
        else if (S.q.length < QUEUE_MAX) {
          S.q.push({ car: newCar(rnd), pat: Math.round(5 + rnd() * 10) });
        } else { S.balked++; }
      }
      for (var i = S.q.length - 1; i >= 0; i--) {
        S.q[i].pat--;
        if (S.q[i].pat <= 0) { S.q.splice(i, 1); S.reneged++; }
      }
      var fi;
      while (S.q.length && (fi = S.cars.findIndex(function (c) { return !c; })) >= 0) {
        S.cars[fi] = S.q.shift().car; S.served++;
      }

      var des = S.cars.map(function (c) { return c ? Math.min(powerCurve(c), cfg.portKW) : 0; });
      var eff = des.slice();
      var nc = nCabinets(cfg);
      S.cabLoad = [];
      for (var cb = 0; cb < nc; cb++) {
        var lo = cb * CAB.portsPer, hi = Math.min(cfg.ports, lo + CAB.portsPer), sum = 0, j;
        for (j = lo; j < hi; j++) sum += des[j] || 0;
        var sc = sum > CAB.kw ? CAB.kw / sum : 1, load = 0;
        for (j = lo; j < hi; j++) { eff[j] = (des[j] || 0) * sc; load += eff[j]; }
        S.cabLoad.push(load);
      }

      var total = eff.reduce(function (a, b) { return a + b; }, 0);
      var battKW = cfg.battery ? Math.min(BATT.disKW, S.soc * 60) : 0;
      var supply = cfg.drawLimit + battKW;
      var scale = 1, gridDraw = 0;
      if (total <= cfg.drawLimit) {
        gridDraw = total;
        if (cfg.battery && S.soc < BATT.capKWh) {
          var ch = Math.min(BATT.chgKW, cfg.drawLimit - total, (BATT.capKWh - S.soc) * 60);
          gridDraw += ch; S.soc = Math.min(BATT.capKWh, S.soc + ch / 60);
        }
      } else if (total <= supply) {
        gridDraw = cfg.drawLimit; S.soc -= (total - cfg.drawLimit) / 60;
      } else {
        scale = supply / total; gridDraw = cfg.drawLimit; S.soc -= battKW / 60;
      }
      S.soc = Math.max(0, S.soc);
      S.gridNow = gridDraw;
      S.kwhGrid += gridDraw / 60;
      S.cabLoad = S.cabLoad.map(function (l) { return l * scale; });
      S.winE += gridDraw / 60;
      if (S.t % 15 === 0) { S.billPeak = Math.max(S.billPeak, S.winE * 4); S.winE = 0; }

      S.cars.forEach(function (c, idx) {
        if (!c) return;
        var cap = powerCurve(c);
        var a = Math.min(cap, cfg.portKW) * scale;
        S.kwhSold += a / 60;
        c.soc += a / 60 / c.E;
        c.ratioSum += cap > 0 ? a / cap : 1;
        c.ticks++;
        if (c.soc >= c.tgt) {
          S.completed++;
          if (c.ratioSum / c.ticks >= HAPPY_THRESHOLD) S.happy++;
          S.cars[idx] = null;
        }
      });
      return S.t < TICKS_PER_DAY;
    }

    return { tick: tick, state: S, config: cfg, scenario: scenario,
             done: function () { return S.t >= TICKS_PER_DAY; } };
  }

  function dayEconomics(S, cfg, scenario) {
    var revenue = S.kwhSold * cfg.price;
    var energyCost = S.kwhGrid * scenario.elec;
    var demandCost = S.billPeak * scenario.demandCharge / 30;
    var capex = capexDaily(cfg);
    var den = S.completed + S.balked + S.reneged;
    return {
      day: S.day,
      revenue: revenue,
      energyCost: energyCost,
      demandCost: demandCost,
      capex: capex,
      profit: revenue - energyCost - demandCost - capex,
      happinessPct: den ? 100 * S.happy / den : 100,
      kwhSold: S.kwhSold,
      billedPeakKW: S.billPeak,
      served: S.served, balked: S.balked, reneged: S.reneged, completed: S.completed,
      utilizationPct: 100 * S.kwhSold / (cfg.ports * cfg.portKW * 24)
    };
  }

  function runDay(cfg, scenario, day) {
    var sim = createSim(cfg, scenario, day);
    while (sim.tick()) { /* run to completion */ }
    return dayEconomics(sim.state, sim.config, scenario);
  }

  /* Official score: average over scenario.days seeded demand days.
   * Profitable designs:   score = avgProfit * (avgHappiness/100)^2
   * Unprofitable designs: score = avgProfit (no multiplier; losses are losses)
   */
  function scoreConfig(cfg, scenario) {
    var nDays = scenario.days || 7;
    var days = [];
    for (var d = 0; d < nDays; d++) days.push(runDay(cfg, scenario, d));
    var avg = function (key) {
      return days.reduce(function (a, r) { return a + r[key]; }, 0) / nDays;
    };
    var avgProfit = avg('profit');
    var avgHap = avg('happinessPct');
    var mult = Math.pow(avgHap / 100, SCORE_HAPPINESS_EXP);
    var score = avgProfit > 0 ? avgProfit * mult : avgProfit;
    return {
      engineVersion: VERSION,
      scenarioId: scenario.id,
      config: validateConfig(cfg, scenario),
      score: Math.round(score * 10) / 10,
      avgProfit: Math.round(avgProfit * 100) / 100,
      avgHappinessPct: Math.round(avgHap * 10) / 10,
      avgUtilizationPct: Math.round(avg('utilizationPct') * 10) / 10,
      avgBilledPeakKW: Math.round(avg('billedPeakKW')),
      days: days,
      formula: 'score = avg daily profit \u00d7 (happiness)^' + SCORE_HAPPINESS_EXP +
               ' when profitable; raw avg profit when not'
    };
  }

  return {
    version: VERSION,
    TICKS_PER_DAY: TICKS_PER_DAY,
    BATT: BATT, CAB: CAB, PORT: PORT, AMORT_DAYS: AMORT_DAYS,
    validateConfig: validateConfig,
    capexDaily: capexDaily,
    nCabinets: nCabinets,
    powerCurve: powerCurve,
    createSim: createSim,
    runDay: runDay,
    dayEconomics: dayEconomics,
    scoreConfig: scoreConfig
  };
});
