-- Выполнить ОДИН РАЗ в Supabase SQL Editor.
-- Добавляет поля, нужные для поиска/фильтра в Telegram-боте:
--   - price_value / price_currency — цена как число + валюта (для
--     фильтра по диапазону; price остаётся текстом для отображения).
--   - district_raw — необработанное название района (для отладки
--     нормализации), сам district теперь хранит УЖЕ каноничное
--     название (см. scraper/src/districts.js).
-- Плюс таблица bot_sessions — хранит состояние "мастера" поиска
-- (какой шаг сейчас проходит пользователь в группе, что уже выбрал),
-- т.к. serverless-функция Vercel не имеет памяти между запросами.

alter table listings add column if not exists price_value numeric;
alter table listings add column if not exists price_currency text; -- 'USD' | 'UZS'
alter table listings add column if not exists district_raw text;

create table if not exists bot_sessions (
  chat_id bigint not null,
  user_id bigint not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (chat_id, user_id)
);

-- Старые незавершённые "мастера поиска" никого не интересуют —
-- не обязательно, но полезно на будущее: можно периодически чистить
-- строки с updated_at старше суток. RLS не включаем — таблица
-- используется только через service_role ключ (Vercel API).
