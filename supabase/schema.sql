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

-- Row Level Security: включаем и НЕ добавляем разрешающих политик.
-- Это значит "запретить всё по умолчанию" — весь доступ идёт только
-- через наш /api (Vercel), который использует service_role ключ и
-- обходит RLS. Анонимный ключ (он публично лежит в JS-бандле сайта)
-- при такой настройке не даёт прочитать ни строки напрямую из
-- Supabase REST API, минуя нашу проверку авторизации.
alter table listings enable row level security;

-- Состояние "мастера" поиска в Telegram-боте (см. client/api/telegram-webhook.js).
create table if not exists bot_sessions (
  chat_id bigint not null,
  user_id bigint not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (chat_id, user_id)
);

-- Тоже без публичных политик — доступ только через service_role в
-- Telegram-вебхуке.
alter table bot_sessions enable row level security;
