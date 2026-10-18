create table if not exists guests (
  id text primary key,
  name text not null,
  phone text not null,
  email text,
  created_at text not null
);

create table if not exists units (
  id text primary key,
  name text not null,
  rate numeric not null check (rate >= 0),
  active boolean not null default true
);

create table if not exists bookings (
  id text primary key,
  guest_id text not null references guests(id),
  unit_id text references units(id),
  check_in text not null,
  check_out text not null,
  reference text not null
);

create table if not exists invoices (
  id text primary key,
  number text not null,
  status text not null check (status in ('draft', 'issued', 'void')),
  guest_id text not null references guests(id),
  booking_id text not null references bookings(id),
  issue_date text not null,
  due_date text not null,
  discount numeric not null default 0,
  additional_charge numeric not null default 0,
  notes text,
  created_at text not null,
  issued_at text
);

create unique index if not exists issued_invoice_number
  on invoices(number) where status = 'issued';

create table if not exists invoice_line_items (
  id text primary key,
  invoice_id text not null references invoices(id) on delete cascade,
  position integer not null,
  description text not null,
  rate numeric not null,
  quantity numeric not null,
  quantity_label text not null,
  total numeric not null
);

create table if not exists payments (
  id text primary key,
  invoice_id text references invoices(id),
  booking_id text references bookings(id),
  guest_id text not null references guests(id),
  kind text not null check (kind in ('payment', 'refund', 'adjustment')),
  amount numeric not null check (amount > 0),
  adjustment_delta numeric,
  method text not null,
  reference text,
  mpesa_sender text,
  mpesa_account text,
  description text,
  received_at text not null,
  created_at text not null
);

create unique index if not exists unique_payment_reference
  on payments(lower(trim(reference)))
  where reference is not null and length(trim(reference)) > 0;

create table if not exists receipts (
  id text primary key,
  number text not null unique,
  payment_id text not null unique references payments(id),
  invoice_id text references invoices(id),
  booking_id text references bookings(id),
  issued_at text not null,
  paid_to_date numeric not null,
  balance_after numeric
);

create table if not exists business_settings (
  key text primary key,
  value jsonb not null
);

create table if not exists audit_logs (
  id text primary key,
  entity_type text not null,
  entity_id text not null,
  action text not null,
  detail text not null,
  created_at text not null
);

create table if not exists counters (
  kind text primary key,
  value integer not null default 0
);

insert into business_settings(key, value)
values ('business', '{}'::jsonb)
on conflict (key) do nothing;

alter table guests enable row level security;
alter table units enable row level security;
alter table bookings enable row level security;
alter table invoices enable row level security;
alter table invoice_line_items enable row level security;
alter table payments enable row level security;
alter table receipts enable row level security;
alter table business_settings enable row level security;
alter table audit_logs enable row level security;
alter table counters enable row level security;
