/**
 * PharmaCore AI — Demo Mode dataset builder.
 *
 * Builds a deterministic sales history on top of the products and users
 * already registered in PharmaCore, so the AI layer can be demonstrated with
 * a realistic volume of transactions without inventing products, users or
 * expiration dates. The same module is loaded by the browser (window.PharmaCoreDemo)
 * and by Node (require('./demo-data')).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PharmaCoreDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAYMENT_METHODS = [
    { method: 'Efectivo', weight: 5 },
    { method: 'Tarjeta', weight: 3 },
    { method: 'Transferencia', weight: 2 },
  ];

  // Deterministic PRNG so every demo run shows the same figures.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function pickWeighted(rand, entries, weightOf) {
    var total = entries.reduce(function (a, e) { return a + weightOf(e); }, 0);
    if (total <= 0) return entries[Math.floor(rand() * entries.length)];
    var target = rand() * total;
    for (var i = 0; i < entries.length; i++) {
      target -= weightOf(entries[i]);
      if (target <= 0) return entries[i];
    }
    return entries[entries.length - 1];
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function isoDate(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  /**
   * @param {Array} products catalogue already loaded in PharmaCore
   * @param {Array} users    user directory already loaded in PharmaCore
   * @param {Object} options { days, salesPerDay, seed, startId, now }
   * @returns {Array} sales records with the same shape as allSales
   */
  function buildSalesHistory(products, users, options) {
    var opts = options || {};
    var days = opts.days || 45;
    var seed = opts.seed || 20260101;
    var startId = opts.startId || 1000;
    var now = opts.now ? new Date(opts.now) : new Date();
    var rand = mulberry32(seed);

    var sellable = (products || []).filter(function (p) { return p && p.name && p.price > 0; });
    var staff = (users || []).filter(function (u) { return u.active !== false; });
    if (!sellable.length || !staff.length) return [];

    var sales = [];
    var counter = startId;

    for (var d = days; d >= 0; d--) {
      var day = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
      var weekday = day.getDay();
      // Fewer transactions on Sundays, more on Fridays/Saturdays.
      var base = weekday === 0 ? 1 : weekday === 5 || weekday === 6 ? 4 : 3;
      var count = base + Math.floor(rand() * 3);

      for (var t = 0; t < count; t++) {
        var lineCount = 1 + Math.floor(rand() * 3);
        var items = [];
        var used = {};
        for (var l = 0; l < lineCount; l++) {
          var product = pickWeighted(rand, sellable, function (p) { return Math.max(1, p.sold || 1); });
          if (used[product.id]) continue;
          used[product.id] = true;
          items.push({ name: product.name, qty: 1 + Math.floor(rand() * 3), price: product.price });
        }
        if (!items.length) continue;

        var subtotal = items.reduce(function (a, it) { return a + it.qty * it.price; }, 0);
        var hour = 8 + Math.floor(rand() * 11);
        var minute = Math.floor(rand() * 60);
        var user = staff[Math.floor(rand() * staff.length)];
        var payment = pickWeighted(rand, PAYMENT_METHODS, function (m) { return m.weight; });

        sales.push({
          id: 'VT-' + String(counter++).padStart(4, '0'),
          date: isoDate(day),
          time: pad(hour) + ':' + pad(minute),
          user: user.name,
          items: items,
          total: Math.round(subtotal * 1.16 * 100) / 100,
          method: payment.method,
          demo: true,
        });
      }
    }

    return sales.sort(function (a, b) {
      return (b.date + b.time).localeCompare(a.date + a.time);
    });
  }

  return { buildSalesHistory: buildSalesHistory, PAYMENT_METHODS: PAYMENT_METHODS };
}));
