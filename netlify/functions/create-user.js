// netlify/functions/create-user.js
//
// Única pieza de backend de esta instalación. Existe exclusivamente porque
// crear una cuenta de Supabase Auth "en nombre de otra persona" requiere la
// service_role key, y esa clave NUNCA puede vivir en el navegador.
//
// Variables de entorno requeridas (configuradas en Netlify, nunca en el repo):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');

const VALID_ROLES = ['Administrador', 'Farmacéutico Senior', 'Cajero', 'Auxiliar'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Función no configurada (faltan variables de entorno en Netlify)' }) };
  }

  const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // 1. Verificar que quien llama está autenticado
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'No autenticado' }) };
  }
  const { data: { user: callerUser }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !callerUser) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Sesión inválida' }) };
  }

  // 2. Verificar que quien llama es Administrador — server-side, no confía en el frontend.
  //    Esto es lo que impide que un Cajero cree usuarios (incluso administradores)
  //    llamando a esta función directamente, sin pasar por la UI.
  const { data: callerProfile, error: callerProfileError } = await supabaseAdmin
    .from('profiles').select('role, active').eq('id', callerUser.id).single();
  if (callerProfileError || !callerProfile || callerProfile.role !== 'Administrador' || !callerProfile.active) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Solo un Administrador activo puede crear usuarios' }) };
  }

  // 3. Validar el cuerpo de la petición
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const { email, password, fullName, role } = body;

  if (!email || !password || !fullName || !role) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan campos obligatorios (email, password, fullName, role)' }) };
  }
  if (password.length < 8) {
    return { statusCode: 400, body: JSON.stringify({ error: 'La contraseña debe tener al menos 8 caracteres' }) };
  }
  if (!VALID_ROLES.includes(role)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Rol inválido. Debe ser uno de: ' + VALID_ROLES.join(', ') }) };
  }

  // 4. Crear el usuario en Supabase Auth
  const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createError) {
    return { statusCode: 400, body: JSON.stringify({ error: createError.message }) };
  }

  // 5. Crear su perfil. Si falla, revertimos el usuario de Auth para no dejar
  //    una cuenta "huérfana" sin perfil (no podría iniciar sesión de forma útil).
  const avatarInitials = fullName.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const { error: profileError } = await supabaseAdmin.from('profiles').insert({
    id: newUser.user.id,
    full_name: fullName,
    role,
    active: true,
    avatar_initials: avatarInitials,
  });
  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(newUser.user.id);
    return { statusCode: 400, body: JSON.stringify({ error: 'No se pudo crear el perfil: ' + profileError.message }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, userId: newUser.user.id, fullName, role }),
  };
};
