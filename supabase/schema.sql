-- ============================================================
-- PHARMACORE AI — ESQUEMA DE BASE DE DATOS (FASE 0/1, aprobado)
-- Ejecutar en: Supabase → SQL Editor, de arriba a abajo, una sola vez
-- por proyecto/instalación.
-- ============================================================
create extension if not exists "pgcrypto";

-- ---------- 1. pharmacy_settings (fila única — patrón singleton) ----------
create table pharmacy_settings (
  id              boolean primary key default true,
  pharmacy_name   text not null default 'PharmaCore',
  logo_url        text,
  address         text,
  phone           text,
  email           text,
  country         text,
  currency_code   text not null default 'BOB',
  currency_symbol text not null default 'Bs',
  tax_name        text not null default 'IVA',
  tax_rate        numeric(5,4) not null default 0.16,
  primary_color   text not null default '#00C48C',
  secondary_color text not null default '#00A376',
  domain          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint pharmacy_settings_singleton check (id)
);
insert into pharmacy_settings (id) values (true);
-- Fila única con los valores por defecto de PharmaCore (branding de la plantilla).
-- El Administrador la edita luego desde "Configuración de Farmacia".

-- ---------- 2. profiles (extiende auth.users) ----------
create table profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  full_name       text not null,
  role            text not null check (role in ('Administrador','Farmacéutico Senior','Cajero','Auxiliar')),
  active          boolean not null default true,
  avatar_initials text,
  avatar_color    text default '#00C48C',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- 3. products ----------
create table products (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  name         text not null,
  lab          text,
  category     text not null check (category in ('Libre','Controlado','Natural')),
  presentation text,
  price        numeric(10,2) not null default 0,
  stock        integer not null default 0,
  stock_min    integer not null default 0,
  expiration   date,
  provider     text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index idx_products_category on products(category);

-- ---------- 4. sales ----------
create sequence sales_ticket_seq start 1;

create table sales (
  id             uuid primary key default gen_random_uuid(),
  ticket_code    text unique not null
                   default ('VT-' || lpad(nextval('sales_ticket_seq')::text, 4, '0')),
  sold_by        uuid not null references profiles(id),
  sale_date      date not null default current_date,
  sale_time      time not null default current_time,
  subtotal       numeric(10,2) not null,
  tax_amount     numeric(10,2) not null,
  total          numeric(10,2) not null,
  payment_method text not null check (payment_method in ('Efectivo','Tarjeta','Transferencia')),
  created_at     timestamptz not null default now()
);
create index idx_sales_sale_date on sales(sale_date);

-- ---------- 5. sale_items ----------
create table sale_items (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid not null references sales(id) on delete cascade,
  product_id   uuid references products(id),
  product_name text not null,   -- snapshot histórico
  category     text not null,   -- snapshot histórico
  quantity     integer not null check (quantity > 0),
  unit_price   numeric(10,2) not null,
  line_total   numeric(10,2) generated always as (quantity * unit_price) stored
);
create index idx_sale_items_sale_id on sale_items(sale_id);
create index idx_sale_items_product_id on sale_items(product_id);

-- ---------- 6. updated_at automático ----------
create or replace function set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

create trigger trg_products_updated_at before update on products
  for each row execute function set_updated_at();
create trigger trg_settings_updated_at before update on pharmacy_settings
  for each row execute function set_updated_at();
create trigger trg_profiles_updated_at before update on profiles
  for each row execute function set_updated_at();

-- ---------- 7. Funciones auxiliares de rol (evitan recursión en RLS) ----------
create or replace function current_user_role() returns text
language sql security definer set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function current_user_active() returns boolean
language sql security definer set search_path = public as $$
  select coalesce(active, false) from profiles where id = auth.uid();
$$;

-- ---------- 8. process_sale — checkout transaccional ----------
create or replace function process_sale(
  p_items jsonb,           -- [{"product_id":"uuid","quantity":2}, ...]
  p_payment_method text
)
returns table(out_ticket_code text, out_subtotal numeric, out_tax numeric, out_total numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id     uuid;
  v_ticket_code text;
  v_subtotal    numeric(10,2) := 0;
  v_tax_rate    numeric(5,4);
  v_tax         numeric(10,2);
  v_total       numeric(10,2);
  v_item        jsonb;
  v_product     products%rowtype;
begin
  if current_user_role() not in ('Administrador','Farmacéutico Senior','Cajero') then
    raise exception 'No autorizado para procesar ventas';
  end if;

  select tax_rate into v_tax_rate from pharmacy_settings where id = true;

  -- Validar stock y calcular subtotal ANTES de escribir nada.
  -- FOR UPDATE bloquea la fila del producto hasta el final de la transacción,
  -- evitando sobreventa si dos ventas concurrentes tocan el mismo producto.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from products
      where id = (v_item->>'product_id')::uuid for update;
    if v_product.id is null then
      raise exception 'Producto no encontrado: %', v_item->>'product_id';
    end if;
    if v_product.stock < (v_item->>'quantity')::int then
      raise exception 'Stock insuficiente para %: disponible %, solicitado %',
        v_product.name, v_product.stock, (v_item->>'quantity')::int;
    end if;
    v_subtotal := v_subtotal + (v_product.price * (v_item->>'quantity')::int);
  end loop;

  v_tax   := round(v_subtotal * v_tax_rate, 2);
  v_total := v_subtotal + v_tax;

  insert into sales (sold_by, subtotal, tax_amount, total, payment_method)
  values (auth.uid(), v_subtotal, v_tax, v_total, p_payment_method)
  returning id, ticket_code into v_sale_id, v_ticket_code;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product from products where id = (v_item->>'product_id')::uuid;
    insert into sale_items (sale_id, product_id, product_name, category, quantity, unit_price)
    values (v_sale_id, v_product.id, v_product.name, v_product.category,
            (v_item->>'quantity')::int, v_product.price);
    update products set stock = stock - (v_item->>'quantity')::int
      where id = v_product.id;
  end loop;

  return query select v_ticket_code, v_subtotal, v_tax, v_total;
end;
$$;

grant execute on function process_sale(jsonb, text) to authenticated;

-- ---------- 9. Row Level Security ----------
alter table pharmacy_settings enable row level security;
alter table profiles enable row level security;
alter table products enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;

-- pharmacy_settings: todo autenticado lee; solo Admin edita
create policy "settings_select_all" on pharmacy_settings
  for select using (auth.uid() is not null);
create policy "settings_update_admin" on pharmacy_settings
  for update using (current_user_role() = 'Administrador');

-- profiles
create policy "profiles_select_self" on profiles
  for select using (id = auth.uid());
create policy "profiles_select_admin" on profiles
  for select using (current_user_role() = 'Administrador');
create policy "profiles_update_admin" on profiles
  for update using (current_user_role() = 'Administrador');

-- products: todos los roles activos leen (incluye Auxiliar); solo Admin/Farmacéutico escriben
create policy "products_select_all" on products
  for select using (current_user_active());
create policy "products_write_admin_farm" on products
  for insert with check (current_user_role() in ('Administrador','Farmacéutico Senior'));
create policy "products_update_admin_farm" on products
  for update using (current_user_role() in ('Administrador','Farmacéutico Senior'));
create policy "products_delete_admin_farm" on products
  for delete using (current_user_role() in ('Administrador','Farmacéutico Senior'));

-- sales / sale_items: SELECT solo Admin/Farmacéutico. No hay policy de INSERT
-- directa: toda venta se crea vía process_sale (security definer, ver arriba).
create policy "sales_select_admin_farm" on sales
  for select using (current_user_role() in ('Administrador','Farmacéutico Senior'));
create policy "sale_items_select_admin_farm" on sale_items
  for select using (current_user_role() in ('Administrador','Farmacéutico Senior'));

-- ============================================================
-- FIN DEL ESQUEMA. Siguiente paso: crear los 4 usuarios demo desde
-- Authentication → Users del Dashboard (ver docs/USUARIOS_DEMO.md),
-- y luego ejecutar seed-demo.sql.
-- ============================================================
