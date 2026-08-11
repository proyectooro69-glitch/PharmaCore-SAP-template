# PHARMACORE AI — TOOL ARCHITECTURE

Documento técnico de la capa de inteligencia añadida a PharmaCore SAP.
Versión 1 — **estrictamente de solo lectura**.

---

## 1. Auditoría de la aplicación existente

| Elemento | Estado encontrado |
|---|---|
| Frontend | `index.html` monolítico (HTML + CSS + JS en un solo archivo) con Chart.js vía CDN |
| Datos | En memoria: `products` (12), `users` (4), `allSales` (7 transacciones) |
| Módulos | Dashboard, Punto de Venta, Inventario, Historial de Ventas, Análisis de Datos, Usuarios |
| Roles | Administrador, Farmacéutico Senior, Cajero, Auxiliar |
| Categorías | Libre, Controlado, Natural |
| Backend | `server.js` (Express) con un borrador de la capa de herramientas |
| Base de datos | No existe: los datos viven en la sesión del navegador |
| Autenticación | Selector de usuario (demo), sin credenciales |
| Lint / typecheck / tests | **No definidos en el repositorio** (ver §8) |

Conclusión de la auditoría: los datos necesarios para el análisis ya existían
(stock, stock mínimo, vencimiento, proveedor, categoría, precio, unidades
vendidas, líneas de venta, método de pago, usuario y fecha). No fue necesario
crear entidades nuevas: solo interpretarlas.

---

## 2. Arquitectura

```
USER
  ↓
PHARMACORE AI (index.html · módulo 🤖)
  ↓  POST /api/ai/chat  ·  POST /api/ai/insights  ·  POST /api/ai/tools/:name
AI AGENT              → detecta la intención y selecciona un PLAN de tools
  ↓
PERMISSION LAYER      → valida el rol ANTES de ejecutar cada tool
  ↓
TOOL LAYER            → TOOL_REGISTRY: parámetros validados, respuesta estructurada
  ↓
BUSINESS LOGIC        → funciones puras sobre productos / ventas / usuarios
  ↓
DATOS DE PHARMACORE   → contexto enviado por el cliente (en memoria)
```

Principios:

1. El agente **nunca** accede a la lógica de negocio directamente; solo nombra herramientas.
2. Cada herramienta declara permiso, parámetros y origen de datos.
3. El modelo de intención es determinista (keywords + contexto conversacional): no genera SQL ni código.
4. Toda la inteligencia vive en el servidor; el navegador solo envía contexto y renderiza HTML estructurado.

---

## 3. Tool Layer

Registro: `TOOL_REGISTRY` en `server.js`. Todas las herramientas son de lectura.

| Tool | Propósito | Parámetros | Permiso | Origen de datos |
|---|---|---|---|---|
| `get_inventory_summary` | Totales, valor, salud del stock y desglose por categoría | — | `inventory_read` | `products` |
| `get_low_stock_products` | Productos bajo el mínimo y agotados, con déficit y riesgo | — | `inventory_read` | `products` |
| `get_out_of_stock_products` | Productos con stock cero | — | `inventory_read` | `products` |
| `get_expiring_products` | Clasificación VENCIDO / CRÍTICO / PRÓXIMO / PRECAUCIÓN | `days` (1–730, def. 90) | `inventory_read` | `products.exp` |
| `get_inventory_alerts` | Alertas combinadas de stock y vencimiento con prioridad | — | `inventory_read` | `products` |
| `get_sales_summary` | Transacciones, ingresos, ticket promedio, métodos de pago | — | `sales` | `sales` |
| `get_sales_by_period` | Ingresos por fecha, mejor y peor día | — | `sales` | `sales.date` |
| `get_top_products` | Productos por unidades vendidas | `limit` (1–50, def. 5) | `products_read` | `products.sold` |
| `get_low_movement_products` | Stock disponible con baja rotación | `threshold` (1–10000, def. 50) | `analysis` | `products.sold` |
| `get_category_performance` | Ingresos, unidades, participación y stock por categoría | — | `analysis` | `products` + `sales` |
| `get_payment_method_summary` | Distribución por método de pago | — | `sales` | `sales.method` |
| `get_product_sales_history` | Historial de ventas de un producto | `product` (texto, requerido) | `sales` | `products` + `sales.items` |
| `get_dashboard_metrics` | Métricas ejecutivas | — | `dashboard` | `products` + `sales` + `users` |
| `get_active_users` | Directorio de usuarios y estado | — | `all` (solo Administrador) | `users` |
| `detect_anomalies` | Anomalías cruzando inventario y ventas | — | `analysis` | `products` + `sales` |

Cada ejecución pasa por `runTool(name, context, args, role)`, que:

1. Rechaza herramientas desconocidas (`UNKNOWN_TOOL`).
2. Verifica el permiso del rol (`PERMISSION_DENIED`) **antes** de ejecutar.
3. Valida y normaliza parámetros (`INVALID_PARAM`) y el contexto (`INVALID_CONTEXT`).
4. Captura errores inesperados, los registra en el servidor y devuelve `TOOL_ERROR`.

### Riesgos por herramienta

| Riesgo | Mitigación |
|---|---|
| Exposición de datos financieros a roles operativos | Permisos `sales` / `analysis` restringidos; insights filtrados por rol |
| Exposición del directorio de usuarios | `get_active_users` requiere el permiso `all` |
| Parámetros abusivos (rangos enormes, texto largo) | `toInt` y `toText` acotan rango y longitud |
| Datos inválidos o vacíos en el contexto | `requireArray` + respuestas explícitas de “datos insuficientes” |
| Interpretación clínica indebida | Las respuestas de vencimiento incluyen la nota de que la decisión de dispensación es del farmacéutico |

---

## 4. Permisos por rol

```
Administrador        → all
Farmacéutico Senior  → inventory, sales, analysis, expiration, products, dashboard
Cajero               → sales, products_read
Auxiliar             → dashboard, inventory_read, products_read
```

Un permiso `X` implica `X_read`. Un rol desconocido cae al rol por defecto (`Auxiliar`),
el de menor alcance.

---

## 5. Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/ai/chat` | Pregunta en lenguaje natural + contexto + historial → respuesta estructurada |
| `POST` | `/api/ai/insights` | 8 tarjetas de análisis, filtradas por rol |
| `GET` | `/api/ai/tools?role=` | Catálogo de herramientas y disponibilidad para el rol |
| `POST` | `/api/ai/tools/:name` | Ejecución controlada de una herramienta concreta |
| `GET` | `/api/ai/roles` | Matriz de roles y permisos |
| `GET` | `/api/health` | Estado del servicio |
| `GET` | `/pharmacore-ai` | Case study (misma SPA) |

Códigos: `400` parámetros/contexto inválidos · `403` permiso denegado · `404` herramienta inexistente.

---

## 6. Formato de respuesta

Cada respuesta del asistente se compone de bloques etiquetados:

- **ORIGEN** — de qué datos de PharmaCore proviene el análisis.
- **DATOS** — hallazgos y tablas.
- **INTERPRETACIÓN** — qué significan.
- **RECOMENDACIÓN** — acción operativa concreta.

Las recomendaciones del análisis integral explican **WHAT / WHY / EVIDENCE / RECOMMENDED ACTION**.

Cuando el contexto no alcanza, la respuesta es explícita:
> “No hay suficientes datos en PharmaCore para realizar este análisis.”

---

## 7. Alcance y límites de la V1

Permitido: leer, analizar, explicar, priorizar y recomendar acciones operativas.

Prohibido por diseño (no existe ninguna ruta que lo haga):

- Modificar inventario, precios, productos, ventas, usuarios o permisos.
- Ejecutar SQL arbitrario o consultas generadas por un modelo.
- Emitir diagnósticos, recomendaciones clínicas o tratamientos.
- Exponer claves o credenciales en el frontend.

**MCP:** PharmaCore AI *no* es hoy un servidor MCP. El registro de herramientas
está modularizado (nombre, descripción, parámetros, permiso, origen, ejecución)
precisamente para exponerse como herramientas MCP en una fase posterior sin
reescribir la capa de negocio.

---

## 8. Verificación

El repositorio **no define** scripts de lint, typecheck ni framework de tests.
Se añadieron dos comprobaciones ejecutables:

```bash
npm run check     # node --check de server.js y demo-data.js
npm start         # arranca en http://localhost:5000
npm run smoke     # smoke test de la capa de IA contra el servidor en marcha
```

`scripts/smoke-ai.js` cubre: salud del servicio, catálogo de tools, las ocho
preguntas sugeridas, conversación con contexto, permisos por rol (Cajero y
Auxiliar), validación de parámetros, herramienta inexistente e insights filtrados.

## 9. Modo Demo

`demo-data.js` genera un historial de ventas determinista (mismo resultado en
cada ejecución) sobre el catálogo real, para que el análisis disponga de volumen
suficiente. No inventa productos, usuarios ni fechas de vencimiento y se puede
desactivar poniendo `DEMO_MODE = false` en `index.html`.
