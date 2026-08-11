-- Выполнить один раз в Supabase SQL Editor.
-- Нужно для детектора "ниже рыночной цены / быстрый уход" — см.
-- scraper/src/marketStats.js, scraper/src/listingDetails.js,
-- scraper/src/urgencySignals.js.

-- Площадь и комнаты раньше заполнялись ТОЛЬКО через ИИ-классификацию
-- (classify.js), которая сейчас отключена (USE_AI_CLASSIFICATION =
-- false) — то есть оба поля были всегда null. Теперь их дополнительно
-- заполняет бесплатный regex-парсер текста объявления (см.
-- listingDetails.js), area/rooms в схеме уже были — просто раньше
-- пустовали.

alter table listings add column if not exists price_per_sqm numeric; -- price_value / area, только когда обе части известны и в одной валюте
alter table listings add column if not exists below_market boolean default false; -- цена/м² заметно ниже медианы по своей группе (район+тип+сделка+валюта)
alter table listings add column if not exists below_market_pct numeric; -- на сколько % ниже медианы (округлено до 0.1)
alter table listings add column if not exists market_sample_size integer; -- сколько объявлений в группе легло в основу медианы — для прозрачности ("мало данных" на карточке)
alter table listings add column if not exists urgency_signal boolean default false; -- в тексте объявления есть слово-маркер срочности ("срочно", "торг" и т.п.)
alter table listings add column if not exists urgency_phrase text; -- какое именно слово/фраза сработали

-- Медианы цены за м² по группам (район+тип недвижимости+тип сделки+
-- валюта), пересчитывается раз в сутки (см. refreshMarketStatsIfStale
-- в marketStats.js, вызывается в начале run.js). Кроме групп по
-- конкретному району, тут же лежат и общегородские группы
-- (district = '__город__') — запасной вариант, когда по конкретному
-- району накопилось слишком мало объявлений для надёжной медианы.
create table if not exists market_stats (
  group_key text primary key, -- 'property_type|deal_type|district|currency', например 'apartment|sale|Чиланзар|USD'
  property_type text,
  deal_type text,
  district text,
  currency text,
  median_price_per_sqm numeric,
  sample_size integer,
  updated_at timestamptz default now()
);
