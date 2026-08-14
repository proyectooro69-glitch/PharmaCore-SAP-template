# Usuarios demo — procedimiento de creación

**No existe ninguna forma segura de crear un usuario de Supabase Auth con contraseña
desde un script SQL versionado en git.** Auth vive aparte de las tablas normales;
por eso este procedimiento es manual, una sola vez, y no deja ningún secreto en el
repositorio.

## Paso 1 — Crear las 4 cuentas en el Dashboard

Supabase → tu proyecto → **Authentication → Users → Add User**.

Crear una por una, marcando **"Auto Confirm User"** (para no depender de un correo
de verificación). La contraseña se escribe directamente en ese formulario — nunca
en un archivo de este repositorio.

| Email sugerido | Nombre completo | Rol |
|---|---|---|
| admin@pharmacore.demo | Carlos Mendoza | Administrador |
| farmaceutico@pharmacore.demo | Lucía Rodríguez | Farmacéutico Senior |
| cajero@pharmacore.demo | Andrés Torres | Cajero |
| auxiliar@pharmacore.demo | María López | Auxiliar |

## Paso 2 — Copiar los UUID generados

Tras crear cada usuario, Supabase le asigna un UUID visible en la lista de
**Authentication → Users**. Cópialo (no es secreto — es un identificador, no
una credencial).

## Paso 3 — Crear su perfil en `profiles`

En el **SQL Editor**, reemplazar los placeholders por los UUID reales y ejecutar:

```sql
insert into profiles (id, full_name, role, active, avatar_initials, avatar_color) values
  ('UUID-DEL-ADMIN',        'Carlos Mendoza',    'Administrador',        true,  'CM', '#00C48C'),
  ('UUID-DEL-FARMACEUTICO', 'Lucía Rodríguez',   'Farmacéutico Senior',  true,  'LR', '#7C3AED'),
  ('UUID-DEL-CAJERO',       'Andrés Torres',     'Cajero',               true,  'AT', '#2563EB'),
  ('UUID-DEL-AUXILIAR',     'María López',       'Auxiliar',             false, 'ML', '#D97706');
```

`María López` queda `active=false`, igual que en los datos demo originales.

## Paso 4 — Ejecutar `seed-demo.sql`

Recién ahora, con las 4 filas de `profiles` creadas, correr `supabase/seed-demo.sql`
(las ventas demo hacen referencia a estos usuarios por nombre).

## Si en el futuro se necesitan crear muchos usuarios de una vez

Existe una alternativa con un script Node ejecutado **localmente**, nunca en
GitHub, usando `supabase.auth.admin.createUser()` con la `service_role key`
leída de una variable de entorno local (nunca escrita a disco, nunca comiteada).
No forma parte de esta fase — se documenta aparte si llega a hacer falta.
