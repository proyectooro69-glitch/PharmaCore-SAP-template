/**
 * Smoke test for the PharmaCore AI layer.
 *
 * Loads the in-memory catalogue directly from index.html (single source of
 * truth for the demo data), starts no server of its own and exercises the AI
 * endpoints of a running instance.
 *
 *   node server.js &
 *   node scripts/smoke-ai.js [baseUrl]
 */
const fs = require('fs');
const path = require('path');
const { buildSalesHistory } = require('../demo-data');

const BASE = process.argv[2] || `http://localhost:${process.env.PORT || 5000}`;
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractArray(name) {
  const start = html.indexOf(`${name}=[`);
  if (start < 0) throw new Error(`No se encontró el arreglo "${name}" en index.html`);
  const open = html.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']' && --depth === 0) {
      return new Function(`return ${html.slice(open, i + 1)};`)();
    }
  }
  throw new Error(`Arreglo "${name}" mal formado en index.html`);
}

const products = extractArray('products');
const users = extractArray('users');
const sales = [...extractArray('allSales'), ...buildSalesHistory(products, users, { days: 45 })];

let failures = 0;

function check(label, condition, detail) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function ask(question, userRole = 'Administrador', conversationHistory = []) {
  const res = await fetch(`${BASE}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, userRole, conversationHistory, context: { products, sales, users } }),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  console.log(`PharmaCore AI smoke test → ${BASE}`);
  console.log(`Contexto: ${products.length} productos · ${sales.length} ventas · ${users.length} usuarios\n`);

  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('GET /api/health', health.status === 'ok', health.name);

  const tools = await (await fetch(`${BASE}/api/ai/tools?role=Administrador`)).json();
  check('GET /api/ai/tools expone el catálogo', tools.tools.length >= 14, `${tools.tools.length} tools`);
  check('Todas las tools son de solo lectura', tools.tools.every(t => t.readOnly));

  const cases = [
    ['¿Qué productos tienen riesgo de quedarse sin stock?', 'low_stock'],
    ['¿Qué productos están próximos a vencer?', 'expiration'],
    ['Analiza las ventas de este mes.', 'sales_period'],
    ['¿Cuáles son los productos más vendidos?', 'top_products'],
    ['¿Qué productos tienen bajo movimiento?', 'low_movement'],
    ['Detecta problemas en mi inventario.', 'anomaly'],
    ['¿Qué categorías generan más ingresos?', 'category'],
    ['Dame tres recomendaciones para mejorar la gestión.', 'recommendations'],
    ['Analiza mi farmacia.', 'business_overview'],
    ['¿Cuál es el método de pago más utilizado?', 'payment'],
    ['Muéstrame el historial de Amoxicilina 500mg', 'product_history'],
    ['¿Qué usuarios están activos?', 'users'],
  ];

  for (const [question, expectedIntent] of cases) {
    const { status, body } = await ask(question);
    check(`chat "${question.slice(0, 46)}"`, status === 200 && body.intent === expectedIntent && !!body.html,
      `intent=${body.intent} tools=${(body.toolsUsed || []).join(',')}`);
  }

  // Contextual conversation
  const first = await ask('¿Qué productos están próximos a vencer?');
  const historyTurn = { role: 'assistant', intent: first.body.intent, contextItems: first.body.contextItems };
  const followUp = await ask('¿Cuáles tienen más stock?', 'Administrador', [historyTurn]);
  check('Chat con contexto (follow-up)', followUp.body.intent === 'follow_up' && !!followUp.body.html,
    `intent=${followUp.body.intent}`);

  // Permissions
  const cashierUsers = await ask('¿Qué usuarios están activos?', 'Cajero');
  check('Cajero no accede al directorio de usuarios', cashierUsers.status === 403 && cashierUsers.body.permissionDenied === true);
  const auxAnalysis = await ask('¿Qué categorías generan más ingresos?', 'Auxiliar');
  check('Auxiliar no accede a análisis financiero', auxAnalysis.status === 403 && auxAnalysis.body.permissionDenied === true);
  const auxStock = await ask('¿Qué productos tienen stock bajo?', 'Auxiliar');
  check('Auxiliar sí consulta inventario', auxStock.status === 200 && auxStock.body.intent === 'low_stock');

  // Tool endpoint validation
  const badParam = await fetch(`${BASE}/api/ai/tools/get_expiring_products`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ products, sales, users, userRole: 'Administrador', params: { days: 99999 } }),
  });
  check('Validación de parámetros en tools', badParam.status === 400, `HTTP ${badParam.status}`);

  const unknown = await fetch(`${BASE}/api/ai/tools/drop_table_products`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ products, sales, users, userRole: 'Administrador' }),
  });
  check('Tool inexistente rechazada', unknown.status === 404);

  // Insights
  const insights = await (await fetch(`${BASE}/api/ai/insights`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ products, sales, users, userRole: 'Administrador' }),
  })).json();
  check('POST /api/ai/insights devuelve 8 tarjetas', insights.insights.length === 8);
  check('Cada tarjeta tiene datos, prioridad y recomendación',
    insights.insights.every(i => i.title && i.priority && i.detail && i.recommendation));

  const cashierInsights = await (await fetch(`${BASE}/api/ai/insights`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ products, sales, users, userRole: 'Cajero' }),
  })).json();
  check('Insights filtrados por rol', cashierInsights.insights.length < 8, `${cashierInsights.insights.length} tarjetas para Cajero`);

  console.log(`\n${failures === 0 ? 'TODAS LAS PRUEBAS PASARON' : `${failures} PRUEBA(S) FALLARON`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
