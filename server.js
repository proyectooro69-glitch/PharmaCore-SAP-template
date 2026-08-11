const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('.'));

// ============================================================
// PERMISSION MODEL
// ============================================================
const ROLE_PERMISSIONS = {
  'Administrador': ['all'],
  'Farmacéutico Senior': ['inventory', 'sales', 'analysis', 'expiration', 'products', 'dashboard'],
  'Cajero': ['sales', 'products_read'],
  'Auxiliar': ['dashboard', 'inventory_read', 'products_read'],
};

const DEFAULT_ROLE = 'Auxiliar';

function hasPermission(role, resource) {
  const perms = ROLE_PERMISSIONS[role] || [];
  if (perms.includes('all')) return true;
  if (perms.includes(resource)) return true;
  if (resource.endsWith('_read') && perms.includes(resource.replace('_read', ''))) return true;
  return false;
}

function resolveRole(role) {
  return ROLE_PERMISSIONS[role] ? role : DEFAULT_ROLE;
}

// ============================================================
// VALIDATION HELPERS — the agent never receives raw user input
// ============================================================

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new ToolError('INVALID_CONTEXT', `"${name}" debe ser una lista de registros de PharmaCore.`);
  return value;
}

function toInt(value, { name, min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ToolError('INVALID_PARAM', `El parámetro "${name}" debe ser numérico.`);
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) throw new ToolError('INVALID_PARAM', `El parámetro "${name}" debe estar entre ${min} y ${max}.`);
  return rounded;
}

function toText(value, { name, maxLength = 120 }) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ToolError('INVALID_PARAM', `El parámetro "${name}" debe ser texto.`);
  return value.trim().slice(0, maxLength);
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:]/g, '')
    .trim();
}

function daysUntil(dateStr, now = new Date()) {
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.ceil((parsed - now) / (1000 * 60 * 60 * 24));
}

// ============================================================
// TOOL LAYER — Each tool validates input, returns structured data
// ============================================================

function get_inventory_summary(products) {
  const total = products.length;
  const outOfStock = products.filter(p => p.stock === 0);
  const lowStock = products.filter(p => p.stock > 0 && p.stock <= p.min);
  const healthy = products.filter(p => p.stock > p.min);
  const totalUnits = products.reduce((a, p) => a + p.stock, 0);
  const totalValue = products.reduce((a, p) => a + p.stock * p.price, 0);
  const byCategory = {
    Libre: products.filter(p => p.cat === 'Libre'),
    Controlado: products.filter(p => p.cat === 'Controlado'),
    Natural: products.filter(p => p.cat === 'Natural'),
  };
  return {
    tool: 'get_inventory_summary',
    total, totalUnits, totalValue: Math.round(totalValue),
    outOfStock: outOfStock.length,
    lowStock: lowStock.length,
    healthy: healthy.length,
    byCategory: {
      Libre: byCategory.Libre.length,
      Controlado: byCategory.Controlado.length,
      Natural: byCategory.Natural.length,
    },
    criticalProducts: [...outOfStock, ...lowStock],
  };
}

function get_low_stock_products(products) {
  const lowStock = products
    .filter(p => p.stock > 0 && p.stock <= p.min)
    .map(p => ({ ...p, gap: p.min - p.stock, riskLevel: p.stock <= p.min * 0.5 ? 'CRÍTICO' : 'BAJO' }))
    .sort((a, b) => a.stock - b.stock);
  const outOfStock = products.filter(p => p.stock === 0);
  return { tool: 'get_low_stock_products', lowStock, outOfStock, total: lowStock.length + outOfStock.length };
}

function get_out_of_stock_products(products) {
  const out = products.filter(p => p.stock === 0);
  return { tool: 'get_out_of_stock_products', products: out, count: out.length };
}

function get_expiring_products(products, days = 90) {
  const now = new Date();
  const classified = products
    .filter(p => daysUntil(p.exp, now) !== null)
    .map(p => {
      const diffDays = daysUntil(p.exp, now);
      let risk = 'NORMAL';
      if (diffDays <= 0) risk = 'VENCIDO';
      else if (diffDays <= 30) risk = 'CRÍTICO';
      else if (diffDays <= 60) risk = 'PRÓXIMO';
      else if (diffDays <= 90) risk = 'PRECAUCIÓN';
      return { ...p, daysLeft: diffDays, risk };
    })
    .filter(p => p.daysLeft <= days)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  return {
    tool: 'get_expiring_products',
    products: classified,
    vencidos: classified.filter(p => p.risk === 'VENCIDO'),
    criticos: classified.filter(p => p.risk === 'CRÍTICO'),
    proximos: classified.filter(p => p.risk === 'PRÓXIMO'),
    precaucion: classified.filter(p => p.risk === 'PRECAUCIÓN'),
    count: classified.length,
  };
}

function get_sales_summary(sales) {
  if (!sales.length) return { tool: 'get_sales_summary', count: 0, total: 0, average: 0, byMethod: {}, byDate: {}, bestDay: { date: '', total: 0 }, recentSales: [] };
  const total = sales.reduce((a, s) => a + s.total, 0);
  const byMethod = {};
  sales.forEach(s => { byMethod[s.method] = (byMethod[s.method] || 0) + 1; });
  const byDate = {};
  sales.forEach(s => { byDate[s.date] = (byDate[s.date] || 0) + s.total; });
  const sortedDates = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0]));
  const bestDay = sortedDates.reduce((best, cur) => cur[1] > best[1] ? cur : best, ['', 0]);
  return {
    tool: 'get_sales_summary',
    count: sales.length,
    total: Math.round(total * 100) / 100,
    average: Math.round((total / sales.length) * 100) / 100,
    byMethod,
    byDate,
    bestDay: { date: bestDay[0], total: Math.round(bestDay[1] * 100) / 100 },
    recentSales: sales.slice(0, 5),
  };
}

function get_top_products(products, limit = 5) {
  const sorted = [...products].sort((a, b) => b.sold - a.sold).slice(0, limit);
  return { tool: 'get_top_products', products: sorted, limit };
}

function get_low_movement_products(products, threshold = 50) {
  const lowMovement = products
    .filter(p => p.sold < threshold && p.stock > 0)
    .sort((a, b) => a.sold - b.sold);
  return { tool: 'get_low_movement_products', products: lowMovement, count: lowMovement.length, threshold };
}

function get_category_performance(products, sales) {
  const catSales = { Libre: 0, Controlado: 0, Natural: 0 };
  const catCount = { Libre: 0, Controlado: 0, Natural: 0 };
  sales.forEach(s => s.items.forEach(it => {
    const p = products.find(pp => pp.name === it.name);
    if (p) {
      catSales[p.cat] = (catSales[p.cat] || 0) + (it.price * it.qty);
      catCount[p.cat] = (catCount[p.cat] || 0) + it.qty;
    }
  }));
  const catStock = {
    Libre: products.filter(p => p.cat === 'Libre').reduce((a, p) => a + p.stock, 0),
    Controlado: products.filter(p => p.cat === 'Controlado').reduce((a, p) => a + p.stock, 0),
    Natural: products.filter(p => p.cat === 'Natural').reduce((a, p) => a + p.stock, 0),
  };
  const totalRevenue = Object.values(catSales).reduce((a, v) => a + v, 0);
  const categories = ['Libre', 'Controlado', 'Natural'].map(cat => ({
    name: cat,
    revenue: Math.round(catSales[cat] * 100) / 100,
    unitsSold: catCount[cat] || 0,
    share: totalRevenue > 0 ? Math.round((catSales[cat] / totalRevenue) * 100) : 0,
    stock: catStock[cat],
    products: products.filter(p => p.cat === cat).length,
  })).sort((a, b) => b.revenue - a.revenue);
  return { tool: 'get_category_performance', categories, totalRevenue: Math.round(totalRevenue) };
}

function get_payment_method_summary(sales) {
  const byMethod = {};
  const revenueByMethod = {};
  sales.forEach(s => {
    byMethod[s.method] = (byMethod[s.method] || 0) + 1;
    revenueByMethod[s.method] = (revenueByMethod[s.method] || 0) + s.total;
  });
  const methods = Object.keys(byMethod).map(m => ({
    method: m,
    count: byMethod[m],
    revenue: Math.round(revenueByMethod[m] * 100) / 100,
    share: Math.round((byMethod[m] / sales.length) * 100),
  })).sort((a, b) => b.count - a.count);
  return { tool: 'get_payment_method_summary', methods, totalSales: sales.length };
}

function get_inventory_alerts(products) {
  const now = new Date();
  const alerts = [];
  products.forEach(p => {
    if (p.stock === 0) alerts.push({ type: 'AGOTADO', priority: 'CRÍTICO', product: p, message: `${p.name} está agotado` });
    else if (p.stock <= p.min * 0.5) alerts.push({ type: 'STOCK_CRÍTICO', priority: 'ALTO', product: p, message: `${p.name} tiene stock crítico (${p.stock}/${p.min} mínimo)` });
    else if (p.stock <= p.min) alerts.push({ type: 'STOCK_BAJO', priority: 'MEDIO', product: p, message: `${p.name} está bajo el mínimo (${p.stock}/${p.min})` });
    const daysLeft = Math.ceil((new Date(p.exp) - now) / (1000 * 60 * 60 * 24));
    if (daysLeft <= 0) alerts.push({ type: 'VENCIDO', priority: 'CRÍTICO', product: p, message: `${p.name} está vencido` });
    else if (daysLeft <= 30) alerts.push({ type: 'PRÓXIMO_VENCIMIENTO', priority: 'ALTO', product: p, message: `${p.name} vence en ${daysLeft} días` });
    else if (daysLeft <= 60) alerts.push({ type: 'VENCIMIENTO_PRÓXIMO', priority: 'MEDIO', product: p, message: `${p.name} vence en ${daysLeft} días` });
  });
  return { tool: 'get_inventory_alerts', alerts, criticalCount: alerts.filter(a => a.priority === 'CRÍTICO').length };
}

function get_dashboard_metrics(products, sales, users) {
  const today = new Date().toISOString().split('T')[0];
  const todaySales = sales.filter(s => s.date === today || s.date === '2025-04-13');
  const totalToday = todaySales.reduce((a, s) => a + s.total, 0);
  const totalRevenue = sales.reduce((a, s) => a + s.total, 0);
  const lowStock = products.filter(p => p.stock > 0 && p.stock <= p.min).length;
  const outOfStock = products.filter(p => p.stock === 0).length;
  return {
    tool: 'get_dashboard_metrics',
    todayRevenue: Math.round(totalToday * 100) / 100,
    todayTransactions: todaySales.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalTransactions: sales.length,
    totalProducts: products.length,
    lowStock, outOfStock,
    activeUsers: users.filter(u => u.active).length,
    avgTicket: sales.length ? Math.round((totalRevenue / sales.length) * 100) / 100 : 0,
  };
}

function detect_anomalies(products, sales) {
  const anomalies = [];
  // High demand + low stock
  products.filter(p => p.stock <= p.min && p.sold > 100).forEach(p => {
    anomalies.push({
      type: 'HIGH_DEMAND_LOW_STOCK',
      severity: 'ALTO',
      product: p.name,
      description: `${p.name} tiene alta demanda (${p.sold} unid. vendidas) pero stock crítico (${p.stock} disponibles vs ${p.min} mínimo). Riesgo de ruptura de stock inminente.`,
      evidence: `Ventas históricas: ${p.sold} | Stock: ${p.stock} | Mínimo: ${p.min}`,
    });
  });
  // High stock + low movement
  products.filter(p => p.stock > 50 && p.sold < 30).forEach(p => {
    anomalies.push({
      type: 'HIGH_STOCK_LOW_MOVEMENT',
      severity: 'MEDIO',
      product: p.name,
      description: `${p.name} tiene stock elevado (${p.stock} unidades) pero baja rotación (${p.sold} unidades vendidas). Posible inmovilización de capital.`,
      evidence: `Stock: ${p.stock} | Ventas históricas: ${p.sold}`,
    });
  });
  // Check for out-of-stock with good historical sales
  products.filter(p => p.stock === 0 && p.sold > 50).forEach(p => {
    anomalies.push({
      type: 'STOCKOUT_HIGH_DEMAND',
      severity: 'CRÍTICO',
      product: p.name,
      description: `${p.name} está agotado a pesar de tener ventas históricas de ${p.sold} unidades. Pérdida de ventas activa.`,
      evidence: `Stock: 0 | Ventas históricas: ${p.sold}`,
    });
  });
  // Revenue concentration
  const catSales = {};
  sales.forEach(s => s.items.forEach(it => {
    const p = products.find(pp => pp.name === it.name);
    if (p) catSales[p.cat] = (catSales[p.cat] || 0) + it.price * it.qty;
  }));
  const totalRev = Object.values(catSales).reduce((a, v) => a + v, 0);
  Object.entries(catSales).forEach(([cat, rev]) => {
    const share = totalRev > 0 ? (rev / totalRev) * 100 : 0;
    if (share > 70) {
      anomalies.push({
        type: 'REVENUE_CONCENTRATION',
        severity: 'MEDIO',
        description: `La categoría "${cat}" concentra el ${Math.round(share)}% de los ingresos. Posible dependencia excesiva de una sola categoría.`,
        evidence: `Ingresos ${cat}: Bs ${Math.round(rev)} de Bs ${Math.round(totalRev)} totales`,
      });
    }
  });
  return { tool: 'detect_anomalies', anomalies, count: anomalies.length };
}

function get_sales_by_period(sales) {
  const byDate = {};
  sales.forEach(s => { byDate[s.date] = (byDate[s.date] || 0) + s.total; });
  const sorted = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0]));
  const bestDay = sorted.reduce((best, cur) => cur[1] > best[1] ? cur : best, ['', 0]);
  const worstDay = sorted.reduce((worst, cur) => cur[1] < worst[1] ? cur : worst, ['', Infinity]);
  return {
    tool: 'get_sales_by_period',
    byDate: Object.fromEntries(sorted),
    bestDay: { date: bestDay[0], total: Math.round(bestDay[1] * 100) / 100 },
    worstDay: { date: worstDay[0], total: Math.round(worstDay[1] * 100) / 100 },
    days: sorted.length,
  };
}

function get_product_sales_history(products, sales, productQuery) {
  const needle = normalize(productQuery);
  if (!needle) throw new ToolError('INVALID_PARAM', 'Indica el nombre del producto a consultar.');
  const product = products.find(p => normalize(p.name).includes(needle) || normalize(p.id) === needle);
  if (!product) return { tool: 'get_product_sales_history', found: false, query: productQuery, lines: [], units: 0, revenue: 0 };
  const lines = [];
  sales.forEach(s => (s.items || []).forEach(it => {
    if (it.name === product.name) lines.push({ saleId: s.id, date: s.date, time: s.time, user: s.user, qty: it.qty, price: it.price, subtotal: Math.round(it.qty * it.price * 100) / 100, method: s.method });
  }));
  lines.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const units = lines.reduce((a, l) => a + l.qty, 0);
  const revenue = lines.reduce((a, l) => a + l.subtotal, 0);
  return {
    tool: 'get_product_sales_history',
    found: true,
    product,
    lines,
    units,
    revenue: Math.round(revenue * 100) / 100,
    transactions: lines.length,
  };
}

function get_active_users(users) {
  const directory = users.map(u => ({
    name: u.name,
    role: u.role,
    active: !!u.active,
    sales: u.sales || 0,
    perms: u.perms || ROLE_PERMISSIONS[u.role]?.join(', ') || '—',
    since: u.since || '—',
  }));
  return {
    tool: 'get_active_users',
    users: directory,
    active: directory.filter(u => u.active).length,
    total: directory.length,
  };
}

// ============================================================
// TOOL REGISTRY — single controlled entry point to business logic.
// Every tool declares its permission, parameters and data source so the
// same definitions can later be exposed as MCP tools without changes.
// ============================================================

const TOOL_REGISTRY = {
  get_inventory_summary: {
    permission: 'inventory_read',
    description: 'Estado agregado del inventario: totales, valor, salud de stock y desglose por categoría.',
    params: {},
    source: 'products',
    run: ({ products }) => get_inventory_summary(products),
  },
  get_low_stock_products: {
    permission: 'inventory_read',
    description: 'Productos por debajo del stock mínimo y agotados, con déficit y nivel de riesgo.',
    params: {},
    source: 'products',
    run: ({ products }) => get_low_stock_products(products),
  },
  get_out_of_stock_products: {
    permission: 'inventory_read',
    description: 'Productos con stock cero.',
    params: {},
    source: 'products',
    run: ({ products }) => get_out_of_stock_products(products),
  },
  get_expiring_products: {
    permission: 'inventory_read',
    description: 'Productos próximos a vencer clasificados en VENCIDO / CRÍTICO / PRÓXIMO / PRECAUCIÓN.',
    params: { days: { type: 'integer', min: 1, max: 730, default: 90 } },
    source: 'products.exp',
    run: ({ products }, args) => get_expiring_products(products, toInt(args.days, { name: 'days', min: 1, max: 730, fallback: 90 })),
  },
  get_inventory_alerts: {
    permission: 'inventory_read',
    description: 'Alertas operativas combinadas de stock y vencimiento con prioridad.',
    params: {},
    source: 'products',
    run: ({ products }) => get_inventory_alerts(products),
  },
  get_sales_summary: {
    permission: 'sales',
    description: 'Resumen de ventas: transacciones, ingresos, ticket promedio y métodos de pago.',
    params: {},
    source: 'sales',
    run: ({ sales }) => get_sales_summary(sales),
  },
  get_sales_by_period: {
    permission: 'sales',
    description: 'Ingresos agrupados por fecha con mejor y peor día registrado.',
    params: {},
    source: 'sales.date',
    run: ({ sales }) => get_sales_by_period(sales),
  },
  get_top_products: {
    permission: 'products_read',
    description: 'Productos ordenados por unidades vendidas históricas.',
    params: { limit: { type: 'integer', min: 1, max: 50, default: 5 } },
    source: 'products.sold',
    run: ({ products }, args) => get_top_products(products, toInt(args.limit, { name: 'limit', min: 1, max: 50, fallback: 5 })),
  },
  get_low_movement_products: {
    permission: 'analysis',
    description: 'Productos con stock disponible y baja rotación histórica.',
    params: { threshold: { type: 'integer', min: 1, max: 10000, default: 50 } },
    source: 'products.sold',
    run: ({ products }, args) => get_low_movement_products(products, toInt(args.threshold, { name: 'threshold', min: 1, max: 10000, fallback: 50 })),
  },
  get_category_performance: {
    permission: 'analysis',
    description: 'Ingresos, unidades, participación y stock por categoría farmacéutica.',
    params: {},
    source: 'products + sales',
    run: ({ products, sales }) => get_category_performance(products, sales),
  },
  get_payment_method_summary: {
    permission: 'sales',
    description: 'Distribución de transacciones e ingresos por método de pago.',
    params: {},
    source: 'sales.method',
    run: ({ sales }) => get_payment_method_summary(sales),
  },
  get_product_sales_history: {
    permission: 'sales',
    description: 'Historial de ventas de un producto concreto.',
    params: { product: { type: 'string', required: true, maxLength: 120 } },
    source: 'products + sales.items',
    run: ({ products, sales }, args) => get_product_sales_history(products, sales, toText(args.product, { name: 'product' })),
  },
  get_dashboard_metrics: {
    permission: 'dashboard',
    description: 'Métricas ejecutivas del dashboard (ingresos, transacciones, alertas, usuarios activos).',
    params: {},
    source: 'products + sales + users',
    run: ({ products, sales, users }) => get_dashboard_metrics(products, sales, users),
  },
  get_active_users: {
    permission: 'all',
    description: 'Directorio de usuarios del sistema y su estado. Solo Administrador.',
    params: {},
    source: 'users',
    run: ({ users }) => get_active_users(users),
  },
  detect_anomalies: {
    permission: 'analysis',
    description: 'Posibles anomalías operativas cruzando inventario y ventas.',
    params: {},
    source: 'products + sales',
    run: ({ products, sales }) => detect_anomalies(products, sales),
  },
};

function listTools(role) {
  return Object.entries(TOOL_REGISTRY).map(([name, def]) => ({
    name,
    description: def.description,
    permission: def.permission,
    params: def.params,
    source: def.source,
    readOnly: true,
    allowedForRole: hasPermission(role, def.permission),
  }));
}

// Executes a registered tool after validating existence, permissions and params.
function runTool(name, context, args = {}, role = DEFAULT_ROLE) {
  const def = TOOL_REGISTRY[name];
  if (!def) return { ok: false, code: 'UNKNOWN_TOOL', error: `La herramienta "${name}" no existe en PharmaCore AI.` };
  if (!hasPermission(role, def.permission)) {
    return { ok: false, code: 'PERMISSION_DENIED', error: `El rol "${role}" no tiene permiso para ejecutar "${name}".`, permission: def.permission };
  }
  try {
    return { ok: true, tool: name, data: def.run(context, args) };
  } catch (err) {
    if (err instanceof ToolError) return { ok: false, code: err.code, error: err.message };
    console.error(`[tool:${name}]`, err);
    return { ok: false, code: 'TOOL_ERROR', error: `Error ejecutando "${name}".` };
  }
}

// ============================================================
// NLU — Intent Detection (Spanish keyword matching)
// ============================================================

const FOLLOW_UP_WORDS = ['de esos', 'de ellos', 'de esas', 'de estos', 'los anteriores', 'esos', 'esas', 'ellos', 'los que', 'cual de', 'cuales de'];

// A follow-up only applies when the previous turn returned items to reason about.
function isFollowUpQuestion(q, lastCtx) {
  if (!lastCtx || !Array.isArray(lastCtx.contextItems) || lastCtx.contextItems.length === 0) return false;
  if (q.length > 90) return false;
  return FOLLOW_UP_WORDS.some(w => q.includes(w)) || /^(y |ademas|cuales|cual|cuantos|cuantas)\b/.test(q);
}

function detectIntent(question, history = []) {
  const q = normalize(question);
  const lastCtx = history.length > 0 ? history[history.length - 1] : null;

  if (isFollowUpQuestion(q, lastCtx)) return 'follow_up';

  if (extractProductQuery(question)) return 'product_history';
  if (q.includes('stock bajo') || q.includes('bajo stock') || q.includes('minimo') || q.includes('minimum') || q.includes('quedarse sin') || q.includes('riesgo de stock') || q.includes('riesgo stock') || q.includes('reponer') || q.includes('reposicion')) return 'low_stock';
  if (q.includes('agotado') || q.includes('sin stock') || q.includes('stock cero')) return 'out_of_stock';
  if (q.includes('venc') || q.includes('expir') || q.includes('caducar') || q.includes('fecha')) return 'expiration';
  if (q.includes('anomal') || q.includes('extran') || q.includes('raro') || q.includes('inusual') || q.includes('detecta problema') || q.includes('detec')) return 'anomaly';
  if (q.includes('mas vendido') || q.includes('top') || q.includes('popular') || q.includes('lider') || q.includes('mejor producto')) return 'top_products';
  if (q.includes('bajo movimiento') || q.includes('poco movimiento') || q.includes('lento') || q.includes('sin movimiento') || q.includes('baja rotacion')) return 'low_movement';
  if (q.includes('categoria') || q.includes('libre') || q.includes('controlado') || q.includes('natural') || q.includes('ingreso') && q.includes('categoria')) return 'category';
  if (q.includes('pago') || q.includes('efectivo') || q.includes('tarjeta') || q.includes('transferencia') || q.includes('metodo')) return 'payment';
  if (q.includes('mejor dia') || q.includes('periodo') || q.includes('semana') || q.includes('mes') || (q.includes('ventas') && q.includes('comportar'))) return 'sales_period';
  if (q.includes('venta') || q.includes('ingreso') || q.includes('revenue') || q.includes('factura')) return 'sales';
  if (q.includes('inventario') || q.includes('stock') || q.includes('productos')) return 'inventory';
  if (q.includes('recomendac') || q.includes('mejorar') || q.includes('optimizar') || q.includes('consejo') || q.includes('sugerencia') || q.includes('three') || q.includes('tres recomendac')) return 'recommendations';
  if (q.includes('analic') || q.includes('anali') || q.includes('diagnostico') || q.includes('resumen') || q.includes('situacion') || q.includes('como esta') || q.includes('estado') || q.includes('overview')) return 'business_overview';
  if (q.includes('usuario') || q.includes('equipo') || q.includes('personal')) return 'users';

  return 'general';
}

// Extracts the product name from questions like "ventas de Amoxicilina 500mg".
// Time expressions ("ventas de este mes") are not products.
const TIME_EXPRESSIONS = ['hoy', 'ayer', 'este mes', 'el mes', 'la semana', 'esta semana', 'este ano', 'el ano', 'el dia', 'los ultimos', 'la farmacia', 'mi farmacia'];

function extractProductQuery(question) {
  const match = question.match(/(?:historial de|ventas de|movimiento de|rotacion de|rotación de)\s+(.+)$/i);
  if (!match) return '';
  const candidate = match[1].replace(/[?¿.!]/g, '').trim();
  const normalized = normalize(candidate);
  if (!candidate || TIME_EXPRESSIONS.some(t => normalized.startsWith(t))) return '';
  return candidate;
}

// ============================================================
// RESPONSE GENERATOR
// ============================================================

function generateResponse(intent, toolResults, question, history, userRole) {
  const q = question.toLowerCase();
  const previousCtx = history.length > 0 ? history[history.length - 1] : null;

  switch (intent) {
    case 'low_stock': return generateLowStockResponse(toolResults, previousCtx);
    case 'out_of_stock': return generateOutOfStockResponse(toolResults);
    case 'expiration': return generateExpirationResponse(toolResults);
    case 'top_products': return generateTopProductsResponse(toolResults);
    case 'low_movement': return generateLowMovementResponse(toolResults);
    case 'sales': return generateSalesResponse(toolResults);
    case 'sales_period': return generateSalesPeriodResponse(toolResults);
    case 'category': return generateCategoryResponse(toolResults);
    case 'payment': return generatePaymentResponse(toolResults);
    case 'inventory': return generateInventoryResponse(toolResults);
    case 'anomaly': return generateAnomalyResponse(toolResults);
    case 'recommendations': return generateRecommendationsResponse(toolResults);
    case 'business_overview': return generateBusinessOverviewResponse(toolResults);
    case 'users': return generateUsersResponse(toolResults);
    case 'product_history': return generateProductHistoryResponse(toolResults);
    case 'follow_up': return generateFollowUpResponse(question, previousCtx);
    default: return generateGeneralResponse(toolResults);
  }
}

function tag(kind, content) {
  const icons = { source: '📂', finding: '🔍', data: '📊', analysis: '💡', recommendation: '✅', warning: '⚠️', critical: '🔴', success: '🟢', info: 'ℹ️' };
  return `<div class="air-section air-${kind}"><span class="air-icon">${icons[kind] || '•'}</span><div class="air-body">${content}</div></div>`;
}

function productTable(items, columns) {
  if (!items || items.length === 0) return '<p class="air-empty">No se encontraron productos.</p>';
  const headers = columns.map(c => `<th>${c.label}</th>`).join('');
  const rows = items.map(p => `<tr>${columns.map(c => `<td>${c.format ? c.format(p) : p[c.key] ?? '—'}</td>`).join('')}</tr>`).join('');
  return `<div class="air-table-wrap"><table class="air-table"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function generateLowStockResponse(data) {
  const { lowStock: ls, outOfStock: oos } = data;
  const total = ls.length + oos.length;
  if (total === 0) return {
    html: tag('success', '<strong>Sin alertas de stock</strong><br>Todos los productos se encuentran por encima de su stock mínimo.'),
    intent: 'low_stock', toolsUsed: ['get_low_stock_products'],
  };
  let html = tag('source', `Basado en el <strong>stock actual y stock mínimo</strong> de ${data.total || (ls.length + oos.length)} productos con alerta en PharmaCore.`);
  html += tag('finding', `Identifiqué <strong>${total} producto${total > 1 ? 's' : ''} con riesgo de stock</strong>: ${oos.length} agotado${oos.length !== 1 ? 's' : ''} y ${ls.length} bajo mínimo.`);
  if (oos.length > 0) {
    html += tag('critical', `<strong>AGOTADOS — Requieren reposición inmediata</strong><br>${productTable(oos, [
      { key: 'name', label: 'Producto' },
      { key: 'cat', label: 'Categoría' },
      { key: 'sold', label: 'Vendidos' },
      { key: 'prov', label: 'Proveedor' },
    ])}`);
  }
  if (ls.length > 0) {
    html += tag('warning', `<strong>STOCK BAJO — Por debajo del mínimo</strong><br>${productTable(ls, [
      { key: 'name', label: 'Producto' },
      { key: 'stock', label: 'Stock Actual' },
      { key: 'min', label: 'Mínimo' },
      { key: 'gap', label: 'Déficit' },
      { key: 'riskLevel', label: 'Riesgo' },
    ])}`);
  }
  const highDemandAtRisk = [...oos, ...ls].filter(p => p.sold > 100);
  if (highDemandAtRisk.length > 0) {
    html += tag('analysis', `<strong>Análisis de prioridad:</strong> ${highDemandAtRisk.map(p => `<strong>${p.name}</strong> (${p.sold} unidades vendidas históricamente) presenta alto riesgo de impacto en ventas.`).join(' ')}`);
  }
  html += tag('recommendation', `<strong>Acción recomendada:</strong> Contactar proveedores para ${oos.length > 0 ? oos.map(p => p.name).join(', ') : 'productos agotados'}. Priorizar por volumen de ventas histórico.`);
  return { html, intent: 'low_stock', toolsUsed: ['get_low_stock_products'], contextItems: [...oos, ...ls] };
}

function generateOutOfStockResponse(data) {
  const { products: out, count } = data;
  if (count === 0) return { html: tag('success', '<strong>Sin productos agotados.</strong> Todos los productos tienen unidades disponibles.'), intent: 'out_of_stock', toolsUsed: ['get_out_of_stock_products'] };
  let html = tag('source', `Basado en el <strong>stock actual</strong> de todos los productos registrados en PharmaCore.`);
  html += tag('critical', `<strong>${count} producto${count !== 1 ? 's' : ''} completamente agotado${count !== 1 ? 's' : ''}:</strong><br>${productTable(out, [
    { key: 'name', label: 'Producto' },
    { key: 'cat', label: 'Categoría' },
    { key: 'sold', label: 'Ventas Hist.' },
    { key: 'prov', label: 'Proveedor' },
    { key: 'min', label: 'Stock Mínimo' },
  ])}`);
  html += tag('recommendation', `Reposición urgente. Los productos agotados con mayor demanda histórica deben priorizarse para evitar pérdida de ventas.`);
  return { html, intent: 'out_of_stock', toolsUsed: ['get_out_of_stock_products'], contextItems: out };
}

function generateExpirationResponse(data) {
  const { products, vencidos, criticos, proximos, precaucion, count } = data;
  if (count === 0) return { html: tag('success', 'Según las fechas de vencimiento registradas, <strong>no se detectaron productos próximos a vencer</strong> en los próximos 90 días.'), intent: 'expiration', toolsUsed: ['get_expiring_products'] };
  let html = tag('source', `Basado en las <strong>fechas de vencimiento registradas</strong> en PharmaCore para ${data.products?.length || count} productos analizados.`);
  html += tag('finding', `Encontré <strong>${count} producto${count !== 1 ? 's' : ''}</strong> con riesgo de vencimiento: ${vencidos.length} vencido${vencidos.length !== 1 ? 's' : ''}, ${criticos.length} crítico${criticos.length !== 1 ? 's' : ''} (≤30 días), ${proximos.length} próximo${proximos.length !== 1 ? 's' : ''} (≤60 días).`);
  const cols = [
    { key: 'name', label: 'Producto' },
    { key: 'cat', label: 'Categoría' },
    { key: 'exp', label: 'Vencimiento' },
    { key: 'daysLeft', label: 'Días Rest.' },
    { key: 'stock', label: 'Stock' },
    { key: 'prov', label: 'Proveedor' },
  ];
  if (vencidos.length > 0) html += tag('critical', `<strong>🔴 VENCIDOS</strong><br>${productTable(vencidos, cols)}`);
  if (criticos.length > 0) html += tag('warning', `<strong>🟠 CRÍTICOS — Vencen en menos de 30 días</strong><br>${productTable(criticos, cols)}`);
  if (proximos.length > 0) html += tag('info', `<strong>🟡 PRÓXIMOS — Vencen en 31–60 días</strong><br>${productTable(proximos, cols)}`);
  if (precaucion.length > 0) html += tag('info', `<strong>🟢 PRECAUCIÓN — Vencen en 61–90 días</strong><br>${productTable(precaucion, cols)}`);
  html += tag('analysis', `<strong>Nota importante:</strong> PharmaCore AI solo reporta las fechas registradas en el sistema. La decisión de dispensación de medicamentos vencidos o próximos a vencer es exclusiva del farmacéutico autorizado.`);
  html += tag('recommendation', `Coordinar con ${[...vencidos, ...criticos].map(p => p.prov).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'proveedores'} para gestionar devoluciones o sustitución. Priorizar productos con mayor stock.`);
  return { html, intent: 'expiration', toolsUsed: ['get_expiring_products'], contextItems: products };
}

function generateTopProductsResponse(data) {
  const { products } = data;
  let html = tag('source', `Basado en las <strong>ventas históricas acumuladas</strong> de todos los productos registrados en PharmaCore.`);
  html += tag('finding', `Los <strong>${products.length} productos más vendidos</strong> concentran la mayor parte del volumen de unidades despachadas.`);
  html += tag('data', productTable(products, [
    { key: 'id', label: 'Código' },
    { key: 'name', label: 'Producto' },
    { key: 'cat', label: 'Categoría' },
    { key: 'sold', label: 'Unidades Vendidas' },
    { key: 'stock', label: 'Stock Actual' },
    { key: 'price', label: 'Precio Bs', format: p => `Bs ${p.price}` },
  ]));
  const atRisk = products.filter(p => p.stock <= p.min);
  if (atRisk.length > 0) html += tag('warning', `<strong>Atención:</strong> ${atRisk.map(p => p.name).join(', ')} figuran entre los más vendidos pero tienen stock bajo o agotado.`);
  html += tag('analysis', `<strong>${products[0].name}</strong> lidera con ${products[0].sold} unidades. Su disponibilidad de stock (${products[0].stock} unid.) debe monitorearse activamente.`);
  return { html, intent: 'top_products', toolsUsed: ['get_top_products'], contextItems: products };
}

function generateLowMovementResponse(data) {
  const { products, count } = data;
  if (count === 0) return { html: tag('success', 'No se detectaron productos con bajo movimiento significativo.'), intent: 'low_movement', toolsUsed: ['get_low_movement_products'] };
  let html = tag('source', `Basado en las <strong>ventas históricas acumuladas</strong> de productos con stock disponible en PharmaCore.`);
  html += tag('finding', `Detecté <strong>${count} producto${count !== 1 ? 's' : ''} con bajo movimiento</strong> (menos de 50 unidades vendidas históricamente).`);
  html += tag('data', productTable(products, [
    { key: 'name', label: 'Producto' },
    { key: 'cat', label: 'Categoría' },
    { key: 'sold', label: 'Unid. Vendidas' },
    { key: 'stock', label: 'Stock' },
    { key: 'price', label: 'Precio', format: p => `Bs ${p.price}` },
    { key: 'exp', label: 'Vencimiento' },
  ]));
  html += tag('analysis', `Los productos con bajo movimiento y stock elevado representan capital inmovilizado. Revisar si son estacionales, si están correctamente ubicados en el punto de venta o si requieren ajuste de estrategia.`);
  html += tag('recommendation', `Evaluar acciones de rotación: reubicación, promociones o revisión de términos con proveedores para devolución de stock sin movimiento.`);
  return { html, intent: 'low_movement', toolsUsed: ['get_low_movement_products'], contextItems: products };
}

function generateSalesResponse(data) {
  const { count, total, average, byMethod, recentSales } = data;
  let html = tag('source', `Basado en las <strong>${count} ventas registradas</strong> en el historial de PharmaCore.`);
  html += tag('data', `<strong>Resumen de ventas:</strong>
    <ul style="margin:8px 0 0 16px;line-height:1.8">
      <li>Total de transacciones: <strong>${count}</strong></li>
      <li>Ingresos totales: <strong>Bs ${total.toLocaleString()}</strong></li>
      <li>Ticket promedio: <strong>Bs ${average}</strong></li>
      <li>Métodos de pago: ${Object.entries(byMethod).map(([m, c]) => `${m} (${c})`).join(', ')}</li>
    </ul>`);
  if (recentSales && recentSales.length > 0) {
    html += tag('data', `<strong>Últimas transacciones:</strong><br>${productTable(recentSales, [
      { key: 'id', label: 'ID' },
      { key: 'date', label: 'Fecha' },
      { key: 'user', label: 'Usuario' },
      { key: 'total', label: 'Total', format: s => `Bs ${s.total.toFixed(2)}` },
      { key: 'method', label: 'Método' },
    ])}`);
  }
  html += tag('analysis', `Con un ticket promedio de Bs ${average} por venta, el flujo de caja muestra ${count >= 5 ? 'actividad regular' : 'actividad limitada en el registro'}.`);
  return { html, intent: 'sales', toolsUsed: ['get_sales_summary'] };
}

function generateSalesPeriodResponse(data) {
  const { byDate, bestDay, worstDay, days } = data;
  let html = tag('source', `Basado en las <strong>ventas por fecha</strong> registradas en PharmaCore (${days} día${days !== 1 ? 's' : ''} con actividad).`);
  html += tag('finding', `El <strong>mejor día</strong> fue <strong>${bestDay.date}</strong> con <strong>Bs ${bestDay.total}</strong> en ventas.`);
  const tableData = Object.entries(byDate).map(([date, total]) => ({ date, total }));
  html += tag('data', productTable(tableData, [
    { key: 'date', label: 'Fecha' },
    { key: 'total', label: 'Ingresos', format: r => `Bs ${r.total.toFixed(2)}` },
  ]));
  html += tag('analysis', `Con ${days} días de datos disponibles, ${days < 7 ? 'el período de análisis es limitado para determinar tendencias definitivas' : 'se puede observar la evolución temporal de ventas'}.`);
  return { html, intent: 'sales_period', toolsUsed: ['get_sales_by_period'] };
}

function generateCategoryResponse(data) {
  const { categories, totalRevenue } = data;
  let html = tag('source', `Basado en el <strong>cruce de ventas e inventario por categoría</strong> registrados en PharmaCore.`);
  html += tag('data', productTable(categories, [
    { key: 'name', label: 'Categoría' },
    { key: 'products', label: 'Productos' },
    { key: 'revenue', label: 'Ingresos', format: c => `Bs ${c.revenue.toLocaleString()}` },
    { key: 'unitsSold', label: 'Unidades' },
    { key: 'share', label: 'Participación', format: c => `${c.share}%` },
    { key: 'stock', label: 'Stock Total' },
  ]));
  const top = categories[0];
  html += tag('analysis', `<strong>${top.name}</strong> es la categoría con mayor generación de ingresos (${top.share}% del total, Bs ${top.revenue.toLocaleString()}). Total de ingresos registrados: Bs ${totalRevenue.toLocaleString()}.`);
  html += tag('recommendation', `Monitorear la concentración de ingresos por categoría para evitar dependencia excesiva. Evaluar estrategias de diversificación si una categoría supera el 70% de ingresos.`);
  return { html, intent: 'category', toolsUsed: ['get_category_performance'] };
}

function generatePaymentResponse(data) {
  const { methods } = data;
  if (!methods.length) return { html: tag('info', 'No hay suficientes datos en PharmaCore para analizar métodos de pago: no existen ventas registradas.'), intent: 'payment', toolsUsed: ['get_payment_method_summary'] };
  let html = tag('source', `Basado en el <strong>método de pago registrado</strong> en cada venta en PharmaCore.`);
  html += tag('data', productTable(methods, [
    { key: 'method', label: 'Método' },
    { key: 'count', label: 'Transacciones' },
    { key: 'share', label: 'Participación', format: m => `${m.share}%` },
    { key: 'revenue', label: 'Ingresos', format: m => `Bs ${m.revenue.toFixed(2)}` },
  ]));
  html += tag('analysis', `El método más utilizado es <strong>${methods[0].method}</strong> con ${methods[0].share}% de las transacciones.`);
  return { html, intent: 'payment', toolsUsed: ['get_payment_method_summary'] };
}

function generateInventoryResponse(data) {
  const { total, totalUnits, totalValue, outOfStock, lowStock, healthy, byCategory } = data;
  let html = tag('source', `Basado en el <strong>inventario actual</strong> de ${total} productos registrados en PharmaCore.`);
  html += tag('data', `<strong>Estado general del inventario:</strong>
    <ul style="margin:8px 0 0 16px;line-height:1.8">
      <li>Total de productos: <strong>${total}</strong></li>
      <li>Unidades en stock: <strong>${totalUnits.toLocaleString()}</strong></li>
      <li>Valor estimado: <strong>Bs ${totalValue.toLocaleString()}</strong></li>
      <li>🟢 Con stock saludable: <strong>${healthy}</strong></li>
      <li>🟡 Con stock bajo: <strong>${lowStock}</strong></li>
      <li>🔴 Agotados: <strong>${outOfStock}</strong></li>
    </ul>`);
  html += tag('data', `<strong>Por categoría:</strong> Libre Venta: ${byCategory.Libre} productos | Controlados: ${byCategory.Controlado} productos | Naturales: ${byCategory.Natural} productos`);
  if (outOfStock + lowStock > 0) html += tag('warning', `<strong>${outOfStock + lowStock} producto${outOfStock + lowStock !== 1 ? 's' : ''}</strong> requieren atención de stock.`);
  return { html, intent: 'inventory', toolsUsed: ['get_inventory_summary'] };
}

function generateAnomalyResponse(data) {
  const { anomalies, count } = data;
  if (count === 0) return { html: tag('success', 'No se detectaron anomalías operativas significativas con los datos disponibles actualmente en PharmaCore.'), intent: 'anomaly', toolsUsed: ['detect_anomalies'] };
  let html = tag('source', `Basado en el <strong>análisis cruzado de inventario y ventas</strong> registrados en PharmaCore.`);
  html += tag('finding', `Detecté <strong>${count} posible${count !== 1 ? 's' : ''} anomalía${count !== 1 ? 's' : ''} operativa${count !== 1 ? 's' : ''}</strong>. Se indica "posible anomalía" cuando no hay suficientes datos para confirmación estadística completa.`);
  anomalies.forEach(a => {
    const sev = a.severity === 'CRÍTICO' ? 'critical' : a.severity === 'ALTO' ? 'warning' : 'info';
    html += tag(sev, `<strong>${a.severity} — ${a.type.replace(/_/g, ' ')}</strong>${a.product ? ` — ${a.product}` : ''}<br>${a.description}<br><span style="font-size:11px;opacity:0.7;margin-top:4px;display:block">Evidencia: ${a.evidence}</span>`);
  });
  html += tag('analysis', `Estas situaciones son indicadores operativos basados en los datos registrados. No implican certeza estadística con el volumen de datos actual.`);
  html += tag('recommendation', `Revisar cada punto con el equipo correspondiente. Las anomalías de stock crítico requieren acción inmediata.`);
  return { html, intent: 'anomaly', toolsUsed: ['detect_anomalies'], contextItems: anomalies };
}

function generateRecommendationsResponse(data) {
  const { inventorySummary, lowStockData, expirationData, categoryData, anomalyData } = data;
  const recs = [];
  const ls = lowStockData?.lowStock || [];
  const oos = lowStockData?.outOfStock || [];
  if (oos.length > 0) recs.push({ priority: 1, icon: '🔴', title: 'Reposición urgente de productos agotados', what: `${oos.length} producto${oos.length !== 1 ? 's' : ''} están completamente agotados`, why: `La venta de estos productos no es posible, generando pérdida directa de ingresos`, evidence: oos.map(p => `${p.name} (${p.sold} unid. hist.)`).join(', '), action: `Contactar a ${[...new Set(oos.map(p => p.prov))].join(', ')} para reposición inmediata` });
  if (ls.length > 0) recs.push({ priority: 2, icon: '🟠', title: 'Gestión preventiva de stock bajo', what: `${ls.length} producto${ls.length !== 1 ? 's' : ''} están por debajo de su stock mínimo`, why: `Sin acción, se convertirán en agotados en corto plazo, especialmente los de alta demanda`, evidence: ls.slice(0, 3).map(p => `${p.name}: ${p.stock}/${p.min}`).join(', '), action: `Iniciar proceso de compra con anticipación suficiente según tiempo de entrega del proveedor` });
  if (expirationData?.criticos?.length > 0) recs.push({ priority: 3, icon: '🟡', title: 'Gestión de vencimientos próximos', what: `${expirationData.criticos.length} producto${expirationData.criticos.length !== 1 ? 's' : ''} vencen en menos de 30 días`, why: `Los productos vencidos no pueden venderse y representan pérdida de inventario`, evidence: expirationData.criticos.map(p => `${p.name} (${p.daysLeft} días)`).join(', '), action: `Coordinar con proveedores para devolución o cambio. Farmacéutico debe validar cada caso` });
  if (categoryData?.categories) {
    const top = categoryData.categories[0];
    if (top && top.share > 60) recs.push({ priority: 4, icon: '📊', title: 'Diversificación de ingresos por categoría', what: `"${top.name}" concentra el ${top.share}% de los ingresos`, why: `Alta concentración genera dependencia y riesgo ante variaciones de demanda`, evidence: `Bs ${top.revenue.toLocaleString()} de ${categoryData.totalRevenue.toLocaleString()} totales`, action: `Evaluar estrategias para potenciar categorías con menor participación` });
  }
  recs.push({ priority: 5, icon: '💡', title: 'Monitoreo continuo de productos de alta rotación', what: `Los productos más vendidos requieren seguimiento frecuente`, why: `Un producto top que se agota impacta directamente en satisfacción y ventas`, evidence: data.topProducts?.products?.slice(0, 3).map(p => `${p.name}: ${p.sold} unid.`).join(', ') || 'Ver análisis de top productos', action: `Establecer alertas de stock para los 5 productos más vendidos` });

  let html = tag('source', `Basado en el <strong>análisis integral</strong> de inventario, ventas y vencimientos de PharmaCore.`);
  html += tag('finding', `Generé <strong>${recs.length} recomendaciones operativas</strong> ordenadas por prioridad.`);
  recs.forEach((r, i) => {
    html += `<div class="air-rec-card">
      <div class="air-rec-header">${r.icon} <strong>#${r.priority} — ${r.title}</strong></div>
      <div class="air-rec-body">
        <div><span class="air-label">QUÉ:</span> ${r.what}</div>
        <div><span class="air-label">POR QUÉ:</span> ${r.why}</div>
        <div><span class="air-label">EVIDENCIA:</span> ${r.evidence}</div>
        <div><span class="air-label">ACCIÓN:</span> <strong>${r.action}</strong></div>
      </div>
    </div>`;
  });
  return { html, intent: 'recommendations', toolsUsed: ['get_low_stock_products', 'get_expiring_products', 'get_category_performance', 'get_top_products'] };
}

function generateBusinessOverviewResponse(data) {
  const m = data.metrics;
  const ls = data.lowStockData;
  const exp = data.expirationData;
  const cat = data.categoryData;
  let html = tag('source', `<strong>RESUMEN EJECUTIVO</strong> — Análisis integral de PharmaCore basado en inventario, ventas y vencimientos registrados.`);
  html += `<div class="air-executive-grid">
    <div class="air-exec-card"><div class="air-exec-val">Bs ${m.totalRevenue.toLocaleString()}</div><div class="air-exec-lbl">Ingresos Totales</div></div>
    <div class="air-exec-card"><div class="air-exec-val">${m.totalTransactions}</div><div class="air-exec-lbl">Transacciones</div></div>
    <div class="air-exec-card air-exec-warn"><div class="air-exec-val">${m.lowStock + m.outOfStock}</div><div class="air-exec-lbl">Alertas de Stock</div></div>
    <div class="air-exec-card"><div class="air-exec-val">Bs ${m.avgTicket}</div><div class="air-exec-lbl">Ticket Promedio</div></div>
  </div>`;
  html += tag('data', `<strong>SITUACIÓN ACTUAL:</strong>
    <ul style="margin:8px 0 0 16px;line-height:1.9">
      <li>Inventario: <strong>${m.totalProducts} productos</strong> — ${m.healthy !== undefined ? m.healthy : m.totalProducts - m.lowStock - m.outOfStock} saludables, ${m.lowStock} bajo mínimo, ${m.outOfStock} agotados</li>
      <li>Ingresos del día: <strong>Bs ${m.todayRevenue.toLocaleString()}</strong> en ${m.todayTransactions} transacciones</li>
      <li>Categoría líder: <strong>${cat?.categories?.[0]?.name || '—'}</strong> (${cat?.categories?.[0]?.share || '—'}% de ingresos)</li>
      <li>Vencimientos críticos: <strong>${exp?.criticos?.length || 0} productos</strong> en ≤30 días</li>
    </ul>`);
  const risks = [];
  if (m.outOfStock > 0) risks.push(`${m.outOfStock} producto${m.outOfStock !== 1 ? 's' : ''} agotado${m.outOfStock !== 1 ? 's' : ''} (pérdida de ventas activa)`);
  if (m.lowStock > 0) risks.push(`${m.lowStock} producto${m.lowStock !== 1 ? 's' : ''} bajo stock mínimo`);
  if (exp?.criticos?.length > 0) risks.push(`${exp.criticos.length} producto${exp.criticos.length !== 1 ? 's' : ''} con vencimiento crítico`);
  if (risks.length > 0) html += tag('warning', `<strong>RIESGOS IDENTIFICADOS:</strong><ul style="margin:8px 0 0 16px;line-height:1.9">${risks.map(r => `<li>${r}</li>`).join('')}</ul>`);
  const ops = [];
  const lowMovement = data.lowMovementData?.products || [];
  if (lowMovement.length > 0) ops.push(`${lowMovement.length} productos con baja rotación — oportunidad de optimización de cartera`);
  if (cat?.categories) {
    const bottomCat = [...cat.categories].sort((a, b) => a.share - b.share)[0];
    if (bottomCat && bottomCat.share < 20) ops.push(`Categoría "${bottomCat.name}" con ${bottomCat.share}% de participación — potencial de crecimiento`);
  }
  if (ops.length > 0) html += tag('info', `<strong>OPORTUNIDADES:</strong><ul style="margin:8px 0 0 16px;line-height:1.9">${ops.map(o => `<li>${o}</li>`).join('')}</ul>`);
  html += tag('recommendation', `<strong>ACCIONES PRIORITARIAS:</strong><ol style="margin:8px 0 0 16px;line-height:1.9"><li>Gestionar reposición de productos agotados y bajo mínimo</li><li>Validar y gestionar productos próximos a vencer</li><li>Revisar rotación de productos con bajo movimiento</li></ol>`);
  return { html, intent: 'business_overview', toolsUsed: ['get_dashboard_metrics', 'get_inventory_summary', 'get_low_stock_products', 'get_expiring_products', 'get_category_performance'] };
}

function generateUsersResponse(toolResults) {
  const { users } = toolResults;
  let html = tag('source', `Basado en el <strong>directorio de usuarios</strong> registrados en PharmaCore.`);
  html += tag('data', productTable(users, [
    { key: 'name', label: 'Usuario' },
    { key: 'role', label: 'Rol' },
    { key: 'active', label: 'Estado', format: u => u.active ? '🟢 Activo' : '⚫ Inactivo' },
    { key: 'sales', label: 'Ventas Proc.' },
    { key: 'perms', label: 'Permisos' },
  ]));
  const active = users.filter(u => u.active).length;
  html += tag('analysis', `${active} de ${users.length} usuarios están activos. El equipo procesa un total de ${users.reduce((a, u) => a + u.sales, 0)} ventas registradas en el sistema.`);
  return { html, intent: 'users', toolsUsed: ['get_active_users'] };
}

function generateProductHistoryResponse(data) {
  if (!data.found) {
    return {
      html: tag('info', `No encontré ningún producto que coincida con <strong>"${data.query}"</strong> en el catálogo de PharmaCore.`),
      intent: 'product_history', toolsUsed: ['get_product_sales_history'],
    };
  }
  const { product, lines, units, revenue, transactions } = data;
  let html = tag('source', `Basado en las <strong>líneas de venta registradas</strong> en PharmaCore para <strong>${product.name}</strong>.`);
  if (transactions === 0) {
    html += tag('warning', `<strong>${product.name}</strong> no registra ventas en el historial disponible. Stock actual: ${product.stock} unidades (mínimo ${product.min}).`);
    html += tag('recommendation', `Revisar si el producto está correctamente disponible en el punto de venta o si procede ajustar su nivel de stock.`);
    return { html, intent: 'product_history', toolsUsed: ['get_product_sales_history'], contextItems: [product] };
  }
  html += tag('finding', `<strong>${product.name}</strong> registra <strong>${units} unidades</strong> en ${transactions} transacción${transactions !== 1 ? 'es' : ''}, con Bs ${revenue.toLocaleString()} en ingresos.`);
  html += tag('data', productTable(lines.slice(0, 10), [
    { key: 'saleId', label: 'Venta' },
    { key: 'date', label: 'Fecha' },
    { key: 'user', label: 'Usuario' },
    { key: 'qty', label: 'Unidades' },
    { key: 'subtotal', label: 'Subtotal', format: l => `Bs ${l.subtotal.toFixed(2)}` },
    { key: 'method', label: 'Método' },
  ]));
  const coverage = product.stock > 0 && units > 0 ? Math.round((product.stock / units) * 100) / 100 : 0;
  html += tag('analysis', `Stock actual: <strong>${product.stock}</strong> unidades frente a un mínimo de ${product.min}. ${coverage ? `Relación stock/unidades vendidas registradas: ${coverage}.` : ''}`);
  html += tag('recommendation', product.stock <= product.min
    ? `Revisar reposición con ${product.prov}: el stock está en o por debajo del mínimo con demanda registrada.`
    : `Mantener el nivel actual de reposición y monitorear la evolución semanal.`);
  return { html, intent: 'product_history', toolsUsed: ['get_product_sales_history'], contextItems: [product] };
}

// Answers questions that refer to the items returned in the previous turn.
function generateFollowUpResponse(question, previousCtx) {
  const items = (previousCtx && previousCtx.contextItems) || [];
  if (!items.length) return generateGeneralResponse({});
  const q = normalize(question);
  const criteria = [
    { keys: ['stock', 'unidades', 'cantidad', 'disponible'], field: 'stock', label: 'stock actual', asc: q.includes('menos') || q.includes('menor') },
    { keys: ['vend', 'demanda', 'rotacion', 'movimiento'], field: 'sold', label: 'unidades vendidas', asc: q.includes('menos') || q.includes('menor') },
    { keys: ['venc', 'caduc', 'expira', 'urgente', 'pronto'], field: 'daysLeft', label: 'días hasta el vencimiento', asc: true },
    { keys: ['precio', 'caro', 'barato', 'valor'], field: 'price', label: 'precio de venta', asc: q.includes('barato') || q.includes('menor') },
  ];
  const chosen = criteria.find(c => c.keys.some(k => q.includes(k)) && items.some(i => i[c.field] !== undefined));
  const field = chosen ? chosen.field : (items[0].stock !== undefined ? 'stock' : null);
  const label = chosen ? chosen.label : 'stock actual';
  const asc = chosen ? chosen.asc : false;

  if (!field) {
    return {
      html: tag('info', `De los <strong>${items.length}</strong> elementos del análisis anterior no puedo derivar ese criterio. Prueba con “los que tienen más stock”, “los más vendidos” o “los que vencen antes”.`),
      intent: 'follow_up', toolsUsed: [], contextItems: items,
    };
  }

  const sorted = [...items]
    .filter(i => typeof i[field] === 'number')
    .sort((a, b) => asc ? a[field] - b[field] : b[field] - a[field]);

  let html = tag('source', `Continuando con los <strong>${items.length} productos</strong> del análisis anterior (${previousCtx.intent || 'consulta previa'}), ordenados por ${label}.`);
  html += tag('finding', `Encabeza la lista <strong>${sorted[0].name}</strong> con ${sorted[0][field]}${field === 'daysLeft' ? ' días restantes' : ''}.`);
  const columns = [
    { key: 'name', label: 'Producto' },
    { key: 'cat', label: 'Categoría' },
    { key: 'stock', label: 'Stock' },
    { key: 'sold', label: 'Vendidos' },
  ];
  if (items.some(i => i.daysLeft !== undefined)) columns.push({ key: 'exp', label: 'Vence' }, { key: 'daysLeft', label: 'Días' });
  html += tag('data', productTable(sorted.slice(0, 8), columns));
  html += tag('recommendation', `Priorizar la gestión operativa siguiendo este orden: ${sorted.slice(0, 3).map(p => p.name).join(', ')}.`);
  return { html, intent: 'follow_up', toolsUsed: [], contextItems: sorted };
}

function generateGeneralResponse(toolResults) {
  const m = toolResults.metrics || {};
  let html = tag('info', `No he podido identificar una consulta específica. Puedo ayudarte con:<br>
    <ul style="margin:8px 0 0 16px;line-height:1.9">
      <li>📦 <strong>Inventario y stock</strong> — ¿Qué productos tienen stock bajo?</li>
      <li>📅 <strong>Vencimientos</strong> — ¿Qué productos están próximos a vencer?</li>
      <li>📈 <strong>Ventas</strong> — ¿Cómo están las ventas?</li>
      <li>💊 <strong>Productos</strong> — ¿Cuáles son los más vendidos?</li>
      <li>⚠️ <strong>Anomalías</strong> — Detecta problemas en mi inventario</li>
      <li>💰 <strong>Categorías</strong> — ¿Qué categoría genera más ingresos?</li>
      <li>💡 <strong>Recomendaciones</strong> — Dame recomendaciones para mejorar</li>
    </ul>`);
  return { html, intent: 'general', toolsUsed: [] };
}

// ============================================================
// AI INSIGHTS GENERATOR
// ============================================================

function generateAIInsights(products, sales, users) {
  const now = new Date();
  const insights = [];

  // 1. Stock Risk
  const lowStock = products.filter(p => p.stock > 0 && p.stock <= p.min);
  const outOfStock = products.filter(p => p.stock === 0);
  const stockRiskLevel = outOfStock.length > 0 ? 'CRÍTICO' : lowStock.length > 3 ? 'ALTO' : lowStock.length > 0 ? 'MEDIO' : 'OK';
  insights.push({
    id: 'stock_risk',
    icon: outOfStock.length > 0 ? '🔴' : lowStock.length > 0 ? '🟠' : '🟢',
    title: 'Stock Risk',
    priority: stockRiskLevel,
    summary: outOfStock.length > 0 ? `${outOfStock.length} producto${outOfStock.length !== 1 ? 's' : ''} agotado${outOfStock.length !== 1 ? 's' : ''}` : lowStock.length > 0 ? `${lowStock.length} bajo mínimo` : 'Inventario saludable',
    detail: `${outOfStock.length} agotados · ${lowStock.length} bajo mínimo de ${products.length} productos`,
    recommendation: outOfStock.length > 0 ? `Reposición urgente: ${outOfStock.slice(0, 2).map(p => p.name).join(', ')}` : lowStock.length > 0 ? `Revisar reposición: ${lowStock.slice(0, 2).map(p => p.name).join(', ')}` : 'Sin acciones de stock requeridas',
  });

  // 2. Expiration Risk
  const expiring = products.map(p => ({
    ...p, daysLeft: Math.ceil((new Date(p.exp) - now) / (1000 * 60 * 60 * 24)),
  }));
  const expired = expiring.filter(p => p.daysLeft <= 0);
  const critical30 = expiring.filter(p => p.daysLeft > 0 && p.daysLeft <= 30);
  const expLevel = expired.length > 0 ? 'CRÍTICO' : critical30.length > 0 ? 'ALTO' : 'OK';
  insights.push({
    id: 'expiration_risk',
    icon: expired.length > 0 ? '🔴' : critical30.length > 0 ? '🟠' : '🟢',
    title: 'Expiration Risk',
    priority: expLevel,
    summary: expired.length > 0 ? `${expired.length} producto${expired.length !== 1 ? 's' : ''} vencido${expired.length !== 1 ? 's' : ''}` : critical30.length > 0 ? `${critical30.length} vencen en ≤30 días` : 'Vencimientos en orden',
    detail: `${expired.length} vencidos · ${critical30.length} críticos (≤30 días)`,
    recommendation: expired.length > 0 ? `Gestionar inmediatamente: ${expired.slice(0, 2).map(p => p.name).join(', ')}` : critical30.length > 0 ? `Coordinar devolución o sustitución` : 'Sin alertas de vencimiento inmediatas',
  });

  // 3. Sales Trend
  const totalRev = sales.reduce((a, s) => a + s.total, 0);
  const avgTicket = sales.length ? Math.round(totalRev / sales.length) : 0;
  insights.push({
    id: 'sales_trend',
    icon: '📈',
    title: 'Sales Trend',
    priority: sales.length > 5 ? 'OK' : 'INFO',
    summary: `Bs ${totalRev.toLocaleString()} registrados`,
    detail: `${sales.length} transacciones · Ticket promedio Bs ${avgTicket}`,
    recommendation: `Monitorear evolución diaria. Ticket promedio actual: Bs ${avgTicket}`,
  });

  // 4. Low Movement
  const lowMov = products.filter(p => p.sold < 50 && p.stock > 0);
  insights.push({
    id: 'low_movement',
    icon: lowMov.length > 3 ? '🐌' : '🟢',
    title: 'Low Movement',
    priority: lowMov.length > 3 ? 'MEDIO' : 'OK',
    summary: `${lowMov.length} con baja rotación`,
    detail: `${lowMov.length} productos vendidos menos de 50 unidades con stock disponible`,
    recommendation: lowMov.length > 0 ? `Evaluar estrategia para: ${lowMov.slice(0, 2).map(p => p.name).join(', ')}` : 'Rotación de inventario saludable',
  });

  // 5. Top Products
  const top3 = [...products].sort((a, b) => b.sold - a.sold).slice(0, 3);
  insights.push({
    id: 'top_products',
    icon: '💊',
    title: 'Top Products',
    priority: 'INFO',
    summary: top3[0]?.name || '—',
    detail: top3.map(p => `${p.name}: ${p.sold} unid.`).join(' · '),
    recommendation: `Asegurar disponibilidad continua de los 3 líderes de venta`,
  });

  // 6. Revenue Opportunities
  const catSales = { Libre: 0, Controlado: 0, Natural: 0 };
  sales.forEach(s => s.items.forEach(it => {
    const p = products.find(pp => pp.name === it.name);
    if (p) catSales[p.cat] = (catSales[p.cat] || 0) + it.price * it.qty;
  }));
  const totalCatRev = Object.values(catSales).reduce((a, v) => a + v, 0);
  const topCat = Object.entries(catSales).sort((a, b) => b[1] - a[1])[0];
  const bottomCat = Object.entries(catSales).sort((a, b) => a[1] - b[1])[0];
  insights.push({
    id: 'revenue_opportunities',
    icon: '💰',
    title: 'Revenue Opportunities',
    priority: 'INFO',
    summary: `${topCat ? topCat[0] : '—'} lidera ingresos`,
    detail: totalCatRev > 0 ? `${topCat?.[0]}: ${Math.round((topCat?.[1] / totalCatRev) * 100)}% · ${bottomCat?.[0]}: ${Math.round((bottomCat?.[1] / totalCatRev) * 100)}%` : 'Sin datos suficientes',
    recommendation: bottomCat && totalCatRev > 0 ? `Potenciar categoría "${bottomCat[0]}" (${Math.round((bottomCat[1] / totalCatRev) * 100)}% de participación)` : 'Analizar distribución de ingresos por categoría',
  });

  // 7. Inventory Anomalies
  const anomalies = [];
  products.forEach(p => {
    if (p.stock === 0 && p.sold > 100) anomalies.push(`${p.name} agotado + alta demanda`);
    if (p.stock > 50 && p.sold < 20) anomalies.push(`${p.name} stock alto + baja rotación`);
  });
  insights.push({
    id: 'inventory_anomalies',
    icon: anomalies.length > 0 ? '⚠️' : '✅',
    title: 'Inventory Anomalies',
    priority: anomalies.length > 0 ? 'MEDIO' : 'OK',
    summary: anomalies.length > 0 ? `${anomalies.length} posible${anomalies.length !== 1 ? 's' : ''} anomalía${anomalies.length !== 1 ? 's' : ''}` : 'Sin anomalías detectadas',
    detail: anomalies.slice(0, 2).join(' · ') || 'Inventario operando con normalidad',
    recommendation: anomalies.length > 0 ? 'Revisar patrones detectados con el equipo' : 'Monitoreo continuo recomendado',
  });

  // 8. AI Recommendations
  const recCount = (outOfStock.length > 0 ? 1 : 0) + (critical30.length > 0 ? 1 : 0) + (lowMov.length > 2 ? 1 : 0) + (anomalies.length > 0 ? 1 : 0);
  insights.push({
    id: 'ai_recommendations',
    icon: '🤖',
    title: 'AI Recommendations',
    priority: recCount > 2 ? 'ALTO' : recCount > 0 ? 'MEDIO' : 'OK',
    summary: `${recCount} recomendación${recCount !== 1 ? 'es' : ''} operativa${recCount !== 1 ? 's' : ''}`,
    detail: `Basado en análisis integral de inventario, ventas y vencimientos`,
    recommendation: 'Pregunta al AI Assistant: "Dame recomendaciones para mejorar"',
  });

  return insights;
}

// ============================================================
// AGENT PLANNER — maps an intent to the tools it is allowed to run.
// The agent never touches business logic directly: it only names tools.
// ============================================================

const INTENT_PLANS = {
  low_stock: [{ tool: 'get_low_stock_products' }],
  out_of_stock: [{ tool: 'get_out_of_stock_products' }],
  expiration: [{ tool: 'get_expiring_products', args: { days: 90 } }],
  top_products: [{ tool: 'get_top_products', args: { limit: 8 } }],
  low_movement: [{ tool: 'get_low_movement_products' }],
  sales: [{ tool: 'get_sales_summary' }],
  sales_period: [{ tool: 'get_sales_by_period' }],
  category: [{ tool: 'get_category_performance' }],
  payment: [{ tool: 'get_payment_method_summary' }],
  inventory: [{ tool: 'get_inventory_summary' }],
  anomaly: [{ tool: 'detect_anomalies' }],
  users: [{ tool: 'get_active_users' }],
  product_history: [{ tool: 'get_product_sales_history', as: 'history' }],
  recommendations: [
    { tool: 'get_low_stock_products', as: 'lowStockData' },
    { tool: 'get_expiring_products', as: 'expirationData', args: { days: 60 } },
    { tool: 'get_category_performance', as: 'categoryData' },
    { tool: 'get_top_products', as: 'topProducts', args: { limit: 5 } },
    { tool: 'get_inventory_summary', as: 'inventorySummary' },
  ],
  business_overview: [
    { tool: 'get_dashboard_metrics', as: 'metrics' },
    { tool: 'get_inventory_summary', as: 'inventorySummary' },
    { tool: 'get_low_stock_products', as: 'lowStockData' },
    { tool: 'get_expiring_products', as: 'expirationData', args: { days: 90 } },
    { tool: 'get_category_performance', as: 'categoryData' },
    { tool: 'get_low_movement_products', as: 'lowMovementData' },
  ],
  follow_up: [],
  general: [{ tool: 'get_dashboard_metrics', as: 'metrics' }],
};

// Runs a plan: single-tool plans return the tool payload directly, multi-tool
// plans return a keyed object. Permission or validation failures abort the plan.
function executePlan(intent, context, role, extraArgs = {}) {
  const plan = INTENT_PLANS[intent] || INTENT_PLANS.general;
  const toolsUsed = [];
  const results = {};
  let single = null;

  for (const step of plan) {
    const args = { ...(step.args || {}), ...(extraArgs[step.tool] || {}) };
    const outcome = runTool(step.tool, context, args, role);
    if (!outcome.ok) return { ok: false, ...outcome };
    toolsUsed.push(step.tool);
    if (step.as) results[step.as] = outcome.data;
    else single = outcome.data;
  }

  const data = plan.length === 1 && !plan[0].as ? single : results;
  return { ok: true, data: data === null ? {} : data, toolsUsed };
}

// ============================================================
// API ROUTES
// ============================================================

app.post('/api/ai/chat', (req, res) => {
  try {
    const { question, context, conversationHistory = [], userRole } = req.body || {};
    if (typeof question !== 'string' || !question.trim()) return res.status(400).json({ error: 'question is required' });
    if (!context || typeof context !== 'object') return res.status(400).json({ error: 'context is required' });

    const role = resolveRole(userRole);
    const cleanQuestion = question.trim().slice(0, 500);
    const history = Array.isArray(conversationHistory) ? conversationHistory.slice(-6) : [];
    const toolContext = {
      products: requireArray(context.products || [], 'products'),
      sales: requireArray(context.sales || [], 'sales'),
      users: requireArray(context.users || [], 'users'),
    };

    const intent = detectIntent(cleanQuestion, history);
    const extraArgs = intent === 'product_history'
      ? { get_product_sales_history: { product: extractProductQuery(cleanQuestion) } }
      : {};

    const execution = executePlan(intent, toolContext, role, extraArgs);
    if (!execution.ok) {
      const denied = execution.code === 'PERMISSION_DENIED';
      return res.status(denied ? 403 : 400).json({
        intent,
        toolsUsed: [],
        permissionDenied: denied,
        code: execution.code,
        html: tag('warning', denied
          ? `El rol <strong>${role}</strong> no tiene permisos para este análisis en PharmaCore AI.`
          : execution.error),
      });
    }

    const payload = intent === 'product_history' ? execution.data.history : execution.data;
    const response = generateResponse(intent, payload, cleanQuestion, history, role);
    res.json({ ...response, role, toolsUsed: response.toolsUsed?.length ? response.toolsUsed : execution.toolsUsed });
  } catch (err) {
    if (err instanceof ToolError) return res.status(400).json({ error: err.message, code: err.code, html: tag('warning', err.message) });
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'Internal error', html: tag('warning', 'Error procesando la consulta. Inténtalo nuevamente.') });
  }
});

// Which permission each insight card requires.
const INSIGHT_PERMISSIONS = {
  stock_risk: 'inventory_read',
  expiration_risk: 'inventory_read',
  sales_trend: 'sales',
  low_movement: 'analysis',
  top_products: 'products_read',
  revenue_opportunities: 'analysis',
  inventory_anomalies: 'analysis',
  ai_recommendations: 'inventory_read',
};

app.get('/api/ai/insights', (req, res) => {
  res.status(405).json({ error: 'Use POST /api/ai/insights con el contexto de PharmaCore en el body.' });
});

app.post('/api/ai/insights', (req, res) => {
  try {
    const { products = [], sales = [], users = [], userRole } = req.body || {};
    const role = resolveRole(userRole);
    const all = generateAIInsights(requireArray(products, 'products'), requireArray(sales, 'sales'), requireArray(users, 'users'));
    const insights = all.filter(i => hasPermission(role, INSIGHT_PERMISSIONS[i.id] || 'all'));
    res.json({ insights, role, restricted: all.length - insights.length });
  } catch (err) {
    if (err instanceof ToolError) return res.status(400).json({ error: err.message, code: err.code });
    console.error('Insights error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Tool catalogue — the same metadata that would be exposed as MCP tools.
app.get('/api/ai/tools', (req, res) => {
  const role = resolveRole(req.query.role);
  res.json({ role, readOnly: true, tools: listTools(role) });
});

// Controlled execution of a single tool (read-only).
app.post('/api/ai/tools/:name', (req, res) => {
  try {
    const { products = [], sales = [], users = [], userRole, params = {} } = req.body || {};
    const role = resolveRole(userRole);
    const context = {
      products: requireArray(products, 'products'),
      sales: requireArray(sales, 'sales'),
      users: requireArray(users, 'users'),
    };
    const outcome = runTool(req.params.name, context, params, role);
    if (!outcome.ok) {
      const status = outcome.code === 'UNKNOWN_TOOL' ? 404 : outcome.code === 'PERMISSION_DENIED' ? 403 : 400;
      return res.status(status).json(outcome);
    }
    res.json(outcome);
  } catch (err) {
    if (err instanceof ToolError) return res.status(400).json({ ok: false, code: err.code, error: err.message });
    console.error('Tool execution error:', err);
    res.status(500).json({ ok: false, code: 'TOOL_ERROR', error: 'Internal error' });
  }
});

// Roles and their permissions, used by the frontend to explain restrictions.
app.get('/api/ai/roles', (req, res) => res.json({ roles: ROLE_PERMISSIONS, defaultRole: DEFAULT_ROLE }));

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', name: 'PharmaCore AI' }));

// Case study deep link — served by the same SPA shell.
app.get('/pharmacore-ai', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`PharmaCore AI v2.0 running on port ${PORT}`);
});
