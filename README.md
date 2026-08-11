# PharmaCore AI

Plataforma de operaciones e inteligencia de negocio farmacéutica.
PharmaCore muestra datos; **PharmaCore AI los interpreta**: encuentra patrones,
explica problemas, detecta riesgos y propone acciones operativas.

## Ejecutar

```bash
npm install
npm start           # http://localhost:5000
```

El módulo de IA vive en el backend Express: abre la aplicación desde el servidor
(no con `file://`) para que el asistente y los insights funcionen.

## Estructura

| Archivo | Contenido |
|---|---|
| `server.js` | API Express, tool layer, permisos por rol y generación de respuestas |
| `index.html` | SPA completa: módulos existentes + módulo 🤖 PharmaCore AI + case study |
| `demo-data.js` | Historial de ventas demo determinista, compartido por el navegador y Node |
| `scripts/smoke-ai.js` | Smoke test de la capa de IA |
| `docs/PHARMACORE-AI-TOOL-ARCHITECTURE.md` | Auditoría, arquitectura, herramientas, permisos y límites |

## Módulo 🤖 PharmaCore AI

- **AI Assistant** con contexto conversacional sobre inventario, ventas y vencimientos.
- **AI Insights**: Stock Risk, Expiration Risk, Sales Trend, Low Movement, Top Products, Revenue Opportunities, Inventory Anomalies y AI Recommendations.
- **AI Executive Insights** en el Dashboard.
- **Case Study** en `/pharmacore-ai`.

Cada respuesta indica su origen y separa **datos**, **interpretación** y **recomendación**.

## Verificación

```bash
npm run check       # comprobación de sintaxis
npm run smoke       # smoke test de la API de IA (requiere el servidor en marcha)
```

## Alcance de la versión 1

Solo lectura: la IA no modifica inventario, precios, ventas, usuarios ni permisos,
no ejecuta SQL generado por un modelo y no emite recomendaciones clínicas.
Detalle completo en la documentación de arquitectura.
