-- ============================================================
-- PHARMACORE AI — LIMPIEZA DE DATOS DEMO
-- Elimina SOLO las filas del seed original (por código/ticket conocidos).
-- No modifica ninguna tabla ni columna — seguro de ejecutar incluso si ya
-- se cargaron productos o ventas reales después del seed, siempre que esos
-- datos reales no reutilicen los códigos PC001-PC012 / VT-0001-VT-0007.
-- ============================================================

delete from sales where ticket_code in
  ('VT-0001','VT-0002','VT-0003','VT-0004','VT-0005','VT-0006','VT-0007');
-- (el delete en cascade también borra sus sale_items automáticamente)

delete from products where code in
  ('PC001','PC002','PC003','PC004','PC005','PC006','PC007',
   'PC008','PC009','PC010','PC011','PC012');

-- Los 4 usuarios demo NO se eliminan automáticamente aquí (ver docs/USUARIOS_DEMO.md).
-- Si ya no se necesitan, se recomienda desactivarlos en vez de borrarlos:
--   update profiles set active = false where full_name in
--     ('Carlos Mendoza','Lucía Rodríguez','Andrés Torres','María López');
-- Borrar un usuario de Auth es irreversible y puede afectar la trazabilidad
-- de "sold_by" en ventas reales de prueba que haya procesado.
