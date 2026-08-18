-- Выполнить один раз в Supabase SQL Editor.
-- Добавляет поля для нового Deal Score, истории цены и подавления
-- дублей без поломки существующих групп Telegram.

alter table listings add column if not exists entity_key text; -- стабильный ключ сущности: phone/url/text hash
alter table listings add column if not exists is_duplicate boolean default false; -- повтор того же объекта, который не нужно отправлять как новое объявление
alter table listings add column if not exists duplicate_of_id text; -- id канонического объявления, если это повтор
alter table listings add column if not exists duplicate_reason text; -- краткое объяснение, почему признали дублем

alter table listings add column if not exists deal_candidate boolean default false; -- попадает ли объявление в группу "Выгодные"
alter table listings add column if not exists deal_score numeric; -- итоговый балл 0-100
alter table listings add column if not exists owner_score numeric; -- вероятность/сила сигнала собственника 0-100
alter table listings add column if not exists deal_score_breakdown jsonb default '{}'::jsonb; -- компоненты скоринга для отладки/карточек
alter table listings add column if not exists owner_score_breakdown jsonb default '{}'::jsonb; -- признаки, из которых собран Owner Score

alter table listings add column if not exists price_history jsonb default '[]'::jsonb; -- массив наблюдений цены по одному listing id
alter table listings add column if not exists price_history_count integer default 0; -- сколько наблюдений накопили
alter table listings add column if not exists price_drop_count integer default 0; -- сколько раз цена снижалась
alter table listings add column if not exists price_change_count integer default 0; -- сколько раз цена менялась вообще
alter table listings add column if not exists first_seen_price_value numeric; -- первая зафиксированная цена
alter table listings add column if not exists last_seen_price_value numeric; -- последняя зафиксированная цена
alter table listings add column if not exists last_price_change_pct numeric; -- последнее изменение цены в процентах
alter table listings add column if not exists last_price_change_at timestamptz; -- когда была последняя смена цены
alter table listings add column if not exists last_seen_at timestamptz; -- когда последний раз видели объявление

-- Таблица истории наблюдений нужна для аудита и для будущих более
-- детальных исследований цены/событий, если понадобится отдельный
-- отчёт по таймлайну.
create table if not exists listing_price_history (
  id bigserial primary key,
  listing_id text not null references listings(id) on delete cascade,
  observed_at timestamptz not null default now(),
  price_value numeric,
  price_currency text,
  price_text text,
  price_per_sqm numeric,
  price_usd numeric,
  source text,
  created_at timestamptz default now()
);

create index if not exists idx_listing_price_history_listing_id_observed_at
  on listing_price_history (listing_id, observed_at desc);

