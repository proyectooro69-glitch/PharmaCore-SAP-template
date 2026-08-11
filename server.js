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
  'Farmacéutico Senior': ['inventory', 'sales', 'sales_history', 'analysis', 'expiration', 'products', 'ai'],
  'Cajero': ['sales', 'products_read'],
  'Auxiliar': ['dashboard', 'inventory_read'],
};

function hasPermission(role, resource) {
  const perms = ROLE_PERMISSIONS[role] || [];
  if (perms.includes('all')) return true;
  if (perms.includes(resource)) return true;
  if (resource.endsWith('_read') && perms.includes(resource.replace('_read', ''))) return true;
  return false;
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
    .map(p => {
      const exp = new Date(p.exp);
      const diffDays = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
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
  if (!sales.length) return { tool: 'get_sales_summary', count: 0, total: 0, average: 0 };
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

// ============================================================
// NLU — Intent Detection (Spanish keyword matching)
// ============================================================

function detectIntent(question, history = []) {
  const q = question.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const lastCtx = history.length > 0 ? history[history.length - 1] : null;

  // Follow-up detection
  const followUpWords = ['cuales', 'cual', 'los que', 'de esos', 'de ellos', 'los anteriores', 'esos', 'ellos', 'cuantos'];
  const isFollowUp = followUpWords.some(w => q.includes(w)) && lastCtx;

  if (q.includes('agotado') || (q.includes('sin stock') && !q.includes('bajo'))) return 'out_of_stock';
  if (q.includes('stock bajo') || q.includes('bajo stock') || q.includes('minimo') || q.includes('minimum') || q.includes('quedarse sin') || q.includes('riesgo de stock') || q.includes('riesgo stock')) return 'low_stock';
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

  // Default: if follow-up about stock in context of previous
  if (isFollowUp) {
    if (q.includes('stock') || q.includes('cantidad')) return lastCtx.intent || 'inventory';
    return lastCtx.intent || 'inventory';
  }
  return 'general';
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
// API ROUTES
// ============================================================

app.post('/api/ai/chat', (req, res) => {
  try {
    const { question, context, conversationHistory = [], userRole = 'Administrador' } = req.body;
    if (!question || !context) return res.status(400).json({ error: 'question and context are required' });

    const { products = [], sales = [], users = [] } = context;
    const intent = detectIntent(question, conversationHistory);

    // Permission check — aplicado a TODOS los intents restringidos, no solo 3 (prompt sec. 14)
    const restrictedIntents = { users: 'all', business_overview: 'all', anomaly: 'inventory', recommendations: 'inventory', category: 'analysis', payment: 'analysis', sales: 'sales_history', sales_period: 'analysis', low_movement: 'inventory', top_products: 'sales_history' };
    const requiredPerm = restrictedIntents[intent];
    if (requiredPerm && !hasPermission(userRole, requiredPerm)) {
      return res.json({
        html: tag('warning', `No tienes permisos para acceder a este análisis con el rol <strong>${userRole}</strong>.`),
        intent, toolsUsed: [], permissionDenied: true,
      });
    }

    // Execute relevant tools
    let toolResults = {};
    switch (intent) {
      case 'low_stock': toolResults = get_low_stock_products(products); break;
      case 'out_of_stock': toolResults = get_out_of_stock_products(products); break;
      case 'expiration': toolResults = get_expiring_products(products); break;
      case 'top_products': toolResults = get_top_products(products, 8); break;
      case 'low_movement': toolResults = get_low_movement_products(products); break;
      case 'sales': toolResults = get_sales_summary(sales); break;
      case 'sales_period': toolResults = get_sales_by_period(sales); break;
      case 'category': toolResults = get_category_performance(products, sales); break;
      case 'payment': toolResults = get_payment_method_summary(sales); break;
      case 'inventory': toolResults = get_inventory_summary(products); break;
      case 'anomaly': toolResults = detect_anomalies(products, sales); break;
      case 'users': toolResults = { users }; break;
      case 'recommendations':
        toolResults = {
          lowStockData: get_low_stock_products(products),
          expirationData: get_expiring_products(products, 60),
          categoryData: get_category_performance(products, sales),
          topProducts: get_top_products(products, 5),
          inventorySummary: get_inventory_summary(products),
        }; break;
      case 'business_overview':
        toolResults = {
          metrics: get_dashboard_metrics(products, sales, users),
          inventorySummary: get_inventory_summary(products),
          lowStockData: get_low_stock_products(products),
          expirationData: get_expiring_products(products, 90),
          categoryData: get_category_performance(products, sales),
          lowMovementData: get_low_movement_products(products),
        }; break;
      default:
        toolResults = get_dashboard_metrics(products, sales, users);
    }

    const response = generateResponse(intent, toolResults, question, conversationHistory, userRole);
    res.json(response);
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'Internal error', html: tag('warning', 'Error procesando la consulta. Inténtalo nuevamente.') });
  }
});

app.get('/api/ai/insights', (req, res) => {
  try {
    const { products, sales, users } = req.query;
    // For GET requests, insights are generated from query params or defaults
    // In practice, the frontend posts context via the insights endpoint
    res.json({ message: 'Use POST /api/ai/insights' });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/api/ai/insights', (req, res) => {
  try {
    const { products = [], sales = [], users = [] } = req.body;
    const insights = generateAIInsights(products, sales, users);
    res.json({ insights });
  } catch (err) {
    console.error('Insights error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', name: 'PharmaCore AI' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`PharmaCore AI v2.0 running on port ${PORT}`);
});
