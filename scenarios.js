/* Station Tycoon v3 — monthly scenarios.
 * One entry per competition month. Changing anything in a published
 * scenario invalidates every score posted against it, so treat entries
 * as immutable once a month opens. Roll a new entry instead.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
  else { root.Scenarios = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCENARIOS = {
    '2026-06': {
      id: '2026-06',
      name: 'Gulf Coast Flagship \u2014 Houston, TX',
      blurb: 'A high-traffic c-store off I-45. The utility approved a 600 kW ' +
             'interconnection and bills demand at $19.50/kW-month on the highest ' +
             '15-minute average. Wholesale energy runs $0.112/kWh.',
      gridKW: 600,
      elec: 0.112,
      demandCharge: 19.50,
      arrivalScale: 1.0,
      days: 7
    },
    '2026-07': {
      id: '2026-07',
      name: 'Mountain Corridor \u2014 Denver, CO',
      blurb: 'A travel-center site on a ski corridor: lighter weekday traffic, ' +
             'brutal weekend peaks. Only 450 kW of interconnection is available, ' +
             'demand bills at $21/kW-month, energy at $0.105/kWh.',
      gridKW: 450,
      elec: 0.105,
      demandCharge: 21.00,
      arrivalScale: 1.1,
      days: 7
    }
  };

  var CURRENT = '2026-06';

  return {
    all: SCENARIOS,
    current: function () { return SCENARIOS[CURRENT]; },
    get: function (id) { return SCENARIOS[id] || null; }
  };
});
