-- Выполнить ОДИН РАЗ в Supabase SQL Editor.
-- Хранит соответствие "тип недвижимости + район" → ID темы (topic) в
-- соответствующей Telegram-супергруппе. Заполняется автоматически
-- скриптом scraper/src/setup-topics.js при первом запуске.

create table if not exists forum_topics (
  group_key text not null,       -- 'apartment' | 'commercial' | 'house'
  district text not null,        -- каноничное имя района (см. districts.js)
  message_thread_id integer not null,
  created_at timestamptz default now(),
  primary key (group_key, district)
);
