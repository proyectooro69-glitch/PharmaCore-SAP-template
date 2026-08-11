# PharmaCore AI

Plataforma de operaciones e inteligencia de negocio farmacéutica.
PharmaCore muestra datos; **PharmaCore AI los interpreta**: encuentra patrones,
explica problemas, detecta riesgos y propone acciones operativas.

## Ejecutar

El sitio es una SPA de un solo archivo (`index.html`). Se puede abrir
directamente en el navegador o servirse como estático (Netlify, GitHub
Pages, cualquier CDN) — **el módulo de IA funciona sin backend**, ya que el
tool layer corre en el propio navegador sobre los datos ya cargados en
memoria.

```bash
# Opción rápida: abrir index.html directamente
open index.html

# O servirlo como estático
npx serve .
```

`server.js` es una arquitectura de referencia para un futuro backend (útil
si el proyecto migra a un hosting con Node); no es necesario para que el
sitio ni el módulo de IA funcionen en Netlify. Ver
`docs/PHARMACORE-AI-TOOL-ARCHITECTURE.md` §7 para el detalle.

## Estructura

| Archivo / carpeta | Contenido |
|---|---|
| `index.html` | SPA completa: módulos existentes (Dashboard, POS, Inventario, Historial, Análisis, Usuarios) + módulo 🤖 PharmaCore AI + Case Study, todo en un solo archivo |
| `server.js` | Arquitectura de referencia: mismo tool layer expuesto como API Express, para un futuro despliegue con Node |
| `docs/PHARMACORE-AI-TOOL-ARCHITECTURE.md` | Auditoría, arquitectura, catálogo de herramientas, permisos y límites |

## Módulo 🤖 PharmaCore AI

- **AI Assistant** con contexto conversacional sobre inventario, ventas y vencimientos.
- **AI Insights**: Stock Risk, Expiration Risk, Sales Trend, Low Movement, Top Products, Revenue Opportunities, Inventory Anomalies y AI Recommendations.
- **AI Executive Insights** en el Dashboard.
- **Case Study** con el detalle de arquitectura, accesible desde el menú lateral.

Cada respuesta indica su origen y separa **datos**, **interpretación** y **recomendación**.

## Permisos por rol

El sidebar muestra solo los módulos permitidos para el rol activo:

| Módulo | Admin | Farmacéutico Senior | Cajero | Auxiliar |
|---|---|---|---|---|
| Dashboard | ✔ | ✔ | ✔ | ✔ |
| Punto de Venta | ✔ | ✔ | ✔ | — |
| Inventario | ✔ (editar) | ✔ (editar) | — | ✔ (solo lectura) |
| Historial de Ventas | ✔ | ✔ | — | — |
| Análisis de Datos | ✔ | ✔ | — | — |
| PharmaCore AI | ✔ | ✔ | — | — |
| Usuarios | ✔ | — | — | — |

## Verificación

```bash
node --check index.html   # (requiere extraer el <script>; ver nota abajo)
node --check server.js    # server.js se verifica directo
```

El módulo de IA en `index.html` se validó con una suite de pruebas
automatizadas (jsdom) que cubre tanto las funciones nuevas como una
regresión completa sobre lo que ya existía (checkout, alta de producto,
filtros). Ver el changelog de la fusión para el detalle de qué se probó.

## Alcance de la versión 1

Solo lectura: la IA no modifica inventario, precios, ventas, usuarios ni
permisos, no ejecuta SQL generado por un modelo y no emite recomendaciones
clínicas. Detalle completo en `docs/PHARMACORE-AI-TOOL-ARCHITECTURE.md`.
