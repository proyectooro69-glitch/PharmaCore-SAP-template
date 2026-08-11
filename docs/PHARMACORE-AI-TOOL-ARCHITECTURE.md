# PHARMACORE AI — TOOL ARCHITECTURE

Documento técnico de la capa de inteligencia añadida a PharmaCore SAP.
Versión 1 — **estrictamente de solo lectura**.

> Nota de procedencia: la primera versión de este documento fue redactada
> para una arquitectura 100% servidor (Express + endpoints REST). Este
> documento la reemplaza para reflejar la arquitectura **real** que corre
> hoy en producción (Netlify, sitio estático, sin backend Node activo).
> `server.js` se conserva como arquitectura de referencia para una futura
> migración a un hosting con Node — ver §7.

---

## 1. Auditoría de la aplicación existente

| Elemento | Estado encontrado |
|---|---|
| Frontend | `index.html` monolítico (HTML + CSS + JS en un solo archivo) con Chart.js vía CDN |
| Datos | En memoria: `products` (12), `users` (4), `allSales` (7 transacciones) |
| Módulos | Dashboard, Punto de Venta, Inventario, Historial de Ventas, Análisis de Datos, Usuarios |
| Roles | Administrador, Farmacéutico Senior, Cajero, Auxiliar |
| Categorías | Libre, Controlado, Natural |
| Hosting | Netlify (sitio estático) — **no ejecuta Node/Express** |
| Backend | `server.js` (Express) — tool layer completo, pero solo se usa si el proyecto se despliega en un hosting con Node (ver §7); en Netlify no está activo |
| Base de datos | No existe: los datos viven en la sesión del navegador |
| Autenticación | Selector de usuario (demo), sin credenciales |

Conclusión de la auditoría: los datos necesarios para el análisis ya existían
(stock, stock mínimo, vencimiento, proveedor, categoría, precio, unidades
vendidas, líneas de venta, método de pago, usuario y fecha). No fue necesario
crear entidades nuevas: solo interpretarlas. El obstáculo real no era de
datos sino de **arquitectura de despliegue** (ver §7).

---

## 2. Arquitectura (versión activa en producción)

```
USER
  ↓
PHARMACORE AI (index.html · módulo 🤖, ejecutado en el navegador)
  ↓
AI AGENT (runAIAgent)     → detecta la intención (keywords + contexto conversacional)
  ↓
PERMISSION LAYER          → valida el rol ANTES de ejecutar cada tool (hasPermission)
  ↓
TOOL LAYER                → funciones get_*/detect_* : parámetros fijos, respuesta estructurada
  ↓
BUSINESS LOGIC            → funciones puras sobre products / allSales / users
  ↓
DATOS DE PHARMACORE       → arrays en memoria del navegador (los mismos que usan
                             Punto de Venta, Inventario e Historial)
```

Principios:

1. El agente **nunca** ejecuta SQL ni código arbitrario; solo llama funciones nombradas del tool layer.
2. Cada herramienta es una función pura: mismos datos de entrada → misma salida.
3. El modelo de intención es determinista (keywords + contexto conversacional): no depende de un LLM externo ni de una API key.
4. El permiso del rol activo se valida **antes** de ejecutar cualquier herramienta restringida.

---

## 3. Tool Layer (implementado en `index.html`, espejo en `server.js`)

| Tool | Propósito | Permiso | Origen de datos |
|---|---|---|---|
| `get_inventory_summary` | Totales, valor, salud del stock y desglose por categoría | `inventory_read` | `products` |
| `get_low_stock_products` | Productos bajo el mínimo y agotados, con déficit y riesgo | `inventory_read` | `products` |
| `get_out_of_stock_products` | Productos con stock cero | `inventory_read` | `products` |
| `get_expiring_products` | Clasificación VENCIDO / CRÍTICO / PRÓXIMO / PRECAUCIÓN | `inventory_read` | `products.exp` |
| `get_sales_summary` | Transacciones, ingresos, ticket promedio, métodos de pago | `sales_history` | `allSales` |
| `get_sales_by_period` | Ingresos por fecha, mejor y peor día | `analysis` | `allSales.date` |
| `get_top_products` | Productos por unidades vendidas | `sales_history` | `products.sold` |
| `get_low_movement_products` | Stock disponible con baja rotación | `inventory` | `products.sold` |
| `get_category_performance` | Ingresos, unidades, participación y stock por categoría | `analysis` | `products` + `allSales` |
| `get_payment_method_summary` | Distribución por método de pago | `analysis` | `allSales.method` |
| `get_dashboard_metrics` | Métricas ejecutivas | `dashboard` | `products` + `allSales` + `users` |
| `detect_anomalies` | Anomalías cruzando inventario y ventas | `inventory` | `products` + `allSales` |

Cada ejecución pasa por `runAIAgent(question, history, userRole)`, que:

1. Detecta la intención (`detectIntent`).
2. Verifica el permiso del rol contra `restrictedIntents` **antes** de ejecutar la herramienta correspondiente.
3. Si el rol no tiene permiso, devuelve un bloque de aviso sin ejecutar ninguna tool.
4. Compone la respuesta en el formato de 3 bloques (§6).

### Riesgos por herramienta

| Riesgo | Mitigación |
|---|---|
| Exposición de datos financieros a roles operativos | Permisos `sales_history` / `analysis` restringidos; el nav oculta el módulo completo a Cajero/Auxiliar |
| Interpretación clínica indebida | Las respuestas de vencimiento indican explícitamente que la decisión de dispensación es del farmacéutico |
| Sobreventa desde el chat | La IA es de solo lectura: no puede modificar `products` ni `allSales`, solo leerlos |

---

## 4. Permisos por rol

```
Administrador        → all
Farmacéutico Senior  → inventory, sales, sales_history, analysis, expiration, products, ai
Cajero               → sales, products_read
Auxiliar             → dashboard, inventory_read
```

Un permiso `X` implica `X_read`. Este modelo se aplica en dos capas:
1. **Navegación**: `applyRolePermissions()` oculta del sidebar los módulos que el rol activo no puede usar (Cajero solo ve Dashboard + Punto de Venta; Auxiliar ve Dashboard + Inventario en solo lectura).
2. **Tool layer de la IA**: `runAIAgent` verifica el permiso antes de ejecutar cada herramienta restringida, aunque el módulo esté oculto para ese rol como defensa adicional.

---

## 5. Formato de respuesta

Cada respuesta del asistente se compone de bloques etiquetados:

- **ORIGEN** — de qué datos de PharmaCore proviene el análisis.
- **DATOS** — hallazgos y tablas.
- **INTERPRETACIÓN** — qué significan.
- **RECOMENDACIÓN** — acción operativa concreta.

Cuando el contexto no alcanza, la respuesta es explícita, por ejemplo:
> "No hay suficientes datos en PharmaCore para realizar este análisis."

---

## 6. Alcance y límites de la V1

Permitido: leer, analizar, explicar, priorizar y recomendar acciones operativas.

Prohibido por diseño (no existe ninguna función que lo haga):

- Modificar inventario, precios, productos, ventas, usuarios o permisos.
- Ejecutar SQL arbitrario o consultas generadas por un modelo externo.
- Emitir diagnósticos, recomendaciones clínicas o tratamientos.
- Exponer claves o credenciales (no hay ninguna: el motor no llama a ningún LLM externo en esta versión).

**MCP:** PharmaCore AI *no* es hoy un servidor MCP. El tool layer está
modularizado (nombre, propósito, permiso, origen) precisamente para poder
exponerse como herramientas MCP en una fase posterior, tanto desde el
cliente como desde `server.js`, sin reescribir la lógica de negocio.

---

## 7. `server.js`: arquitectura de referencia para un futuro backend

`server.js` contiene el mismo tool layer, detección de intención y
generador de respuestas, expuesto como una API Express
(`POST /api/ai/chat`, `POST /api/ai/insights`, `GET /api/health`) y con el
mismo modelo de permisos que el cliente. **No está activo en el
despliegue actual de Netlify** porque Netlify sirve archivos estáticos y
no ejecuta procesos Node de larga duración.

Si en el futuro el proyecto migra a un hosting con Node (Railway, Render,
Vercel con Functions, un VPS, etc.), `server.js` puede activarse
sustituyendo las llamadas locales del cliente (`runAIAgent`, `get_*`) por
`fetch('/api/ai/chat', …)` contra ese backend, sin cambiar el contrato de
datos ni el formato de respuesta — ambos ya son idénticos.

```bash
npm install
npm start          # arranca server.js en http://localhost:5000 (referencia/futuro)
```

## 8. Verificación

El módulo de IA del cliente se validó con una suite de pruebas
automatizadas (jsdom) que ejercita: existencia y render del módulo,
respuestas del agente ante distintas preguntas, contexto conversacional,
visibilidad de navegación por rol, redirección al cambiar de rol,
solo-lectura de Auxiliar, tope de stock en el carrito, cálculo de IVA, y
regresión completa sobre checkout, alta de producto y filtros de POS.
`server.js` se verifica por separado con `node --check server.js` y un
arranque de humo (`npm start` + `curl /api/health`).
