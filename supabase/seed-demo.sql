-- ============================================================
-- PHARMACORE AI — SEED DE DATOS DEMO (Opción A: totales con IVA 16% correcto)
-- Ejecutar DESPUÉS de schema.sql y DESPUÉS de crear los 4 usuarios demo
-- en Authentication → Users + sus filas en profiles (ver docs/USUARIOS_DEMO.md).
-- ============================================================

-- ---------- Productos (12) ----------
insert into products (code, name, lab, category, presentation, price, stock, stock_min, expiration, provider) values
  ('PC001','Amoxicilina 500mg','Roewe','Libre','Cápsulas x30',45,120,20,'2026-08-01','DistribFarma'),
  ('PC002','Ibuprofeno 400mg','Bayer','Libre','Tabletas x20',28,85,15,'2026-11-15','Bayer Direct'),
  ('PC003','Clonazepam 0.5mg','Roche','Controlado','Tabletas x30',95,18,5,'2025-12-31','Roche Pharma'),
  ('PC004','Paracetamol 500mg','Genérico','Libre','Tabletas x100',22,6,30,'2027-03-20','FarmaGen'),
  ('PC005','Alprazolam 1mg','Pfizer','Controlado','Tabletas x15',110,12,5,'2026-05-10','Pfizer'),
  ('PC006','Equinacea Plus','NaturVital','Natural','Cápsulas x60',65,42,10,'2026-09-01','NaturVital'),
  ('PC007','Omeprazol 20mg','AstraZeneca','Libre','Cápsulas x28',38,55,15,'2027-01-15','AZ Direct'),
  ('PC008','Melatonina 5mg','Solgar','Natural','Tabletas x60',75,29,10,'2026-10-20','NaturDist'),
  ('PC009','Metformina 850mg','Merck','Libre','Tabletas x60',42,0,10,'2026-07-30','Merck'),
  ('PC010','Diazepam 5mg','Roche','Controlado','Tabletas x30',85,9,5,'2026-04-15','Roche'),
  ('PC011','Valeriana Ext.','Farma Natural','Natural','Gotas 30ml',52,33,8,'2026-12-01','NaturVital'),
  ('PC012','Atorvastatina 40mg','Pfizer','Libre','Tabletas x30',88,41,10,'2027-02-28','Pfizer');

-- ---------- Ventas (7) — montos con IVA 16% ya aplicado (Opción A, aprobada) ----------
-- ticket_code se genera solo por la secuencia: VT-0001 .. VT-0007, en este orden.
insert into sales (sold_by, sale_date, sale_time, subtotal, tax_amount, total, payment_method)
select id, '2025-04-13', '08:32', 118.00, 18.88, 136.88, 'Efectivo' from profiles where full_name='Lucía Rodríguez'
union all
select id, '2025-04-13', '09:14',  95.00, 15.20, 110.20, 'Tarjeta'      from profiles where full_name='Carlos Mendoza'
union all
select id, '2025-04-13', '10:05', 104.00, 16.64, 120.64, 'Efectivo'     from profiles where full_name='Andrés Torres'
union all
select id, '2025-04-13', '11:22', 130.00, 20.80, 150.80, 'Transferencia' from profiles where full_name='Lucía Rodríguez'
union all
select id, '2025-04-12', '14:10', 127.00, 20.32, 147.32, 'Efectivo'     from profiles where full_name='Carlos Mendoza'
union all
select id, '2025-04-12', '15:40',  88.00, 14.08, 102.08, 'Tarjeta'      from profiles where full_name='Andrés Torres'
union all
select id, '2025-04-11', '09:00', 220.00, 35.20, 255.20, 'Efectivo'     from profiles where full_name='Lucía Rodríguez';

-- ---------- Líneas de venta (sale_items) ----------
insert into sale_items (sale_id, product_id, product_name, category, quantity, unit_price)
select s.id, p.id, p.name, p.category, v.qty, v.price
from (values
  ('VT-0001','PC001',2,45), ('VT-0001','PC002',1,28),
  ('VT-0002','PC003',1,95),
  ('VT-0003','PC004',3,22), ('VT-0003','PC007',1,38),
  ('VT-0004','PC006',2,65),
  ('VT-0005','PC008',1,75), ('VT-0005','PC011',1,52),
  ('VT-0006','PC012',1,88),
  ('VT-0007','PC005',2,110)
) as v(ticket, code, qty, price)
join sales s on s.ticket_code = v.ticket
join products p on p.code = v.code;

-- Nota: los valores de "stock" insertados arriba en products YA reflejan el
-- estado posterior a estas 7 ventas (igual que en el index.html original),
-- por lo que NO hace falta un UPDATE adicional de stock en este script.

-- ============================================================
-- Verificación rápida (opcional, ejecutar después del seed):
--   select ticket_code, subtotal, tax_amount, total from sales order by ticket_code;
--   select code, name, stock from products order by code;
-- ============================================================
