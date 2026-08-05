-- Выполнить один раз в Supabase: Project → SQL Editor → New query → вставить и Run

create table if not exists listings (
  id text primary key,
  source text,
  deal_type text,
  property_type text default 'apartment', -- 'apartment' | 'house' | 'commercial'
  url text,
  title text,
  price text,
  posted_raw text,
  raw_text text,
  district text,
  district_raw text,
  price_value numeric,
  price_currency text, -- 'USD' | 'UZS'
  rooms integer,
  area double precision,
  phone text,
  seller_type text,
  confidence text,
  label_text text,
  label_kind text,
  seller_name text,
  seller_listings_count integer,
  notified boolean default false,
  contacted boolean default false,
  created_at timestamptz default now()
);

-- Row Level Security включаем на всякий случай, но наш бэкенд (GitHub
-- Actions и Vercel API) обращается через service_role ключ, который
-- обходит RLS — так что для работы системы политики ниже не обязательны.
-- Они нужны только если решите читать таблицу напрямую с фронтенда
-- через анонимный ключ, минуя наш /api.
alter table listings enable row level security;

create policy "Публичное чтение" on listings
  for select using (true);

-- Состояние "мастера" поиска в Telegram-боте (см. client/api/telegram-webhook.js).
create table if not exists bot_sessions (
  chat_id bigint not null,
  user_id bigint not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (chat_id, user_id)
);
