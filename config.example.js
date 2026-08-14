// config.example.js
// Copiar este archivo a "config.js" y completar con los valores REALES
// del proyecto Supabase de ESTA instalación (Project Settings → API).
//
// La anon key NO es secreta: está diseñada por Supabase para ser pública.
// La protección real de los datos la da Row Level Security (RLS), no la
// confidencialidad de esta clave. Por eso "config.js" sí se puede comitear
// al repositorio de cada instalación.
//
// NUNCA pongas aquí la "service_role key" — esa es secreta y solo debe
// vivir como variable de entorno de Netlify (la usa netlify/functions/create-user.js).

window.PHARMACORE_CONFIG = {
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_ANON_KEY: "TU-ANON-KEY-PUBLICA",
};
