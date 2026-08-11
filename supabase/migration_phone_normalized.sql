-- Выполнить ОДИН РАЗ в Supabase SQL Editor.
-- Нужна для проверки "один и тот же номер телефона — на нескольких
-- РАЗНЫХ объявлениях" (сильный сигнал агента/риелтора — см.
-- scraper/src/db.js: countListingsByPhone, scraper/src/phone.js).
--
-- Колонка phone у нас хранит номер как есть, с разным форматированием
-- у разных источников ("+99 893 1804767" vs "998901234567" и т.п.),
-- поэтому для СРАВНЕНИЯ используем отдельную нормализованную колонку
-- (последние 9 цифр номера), а исходную phone не трогаем — она нужна
-- для отображения в Telegram/на сайте как есть.

alter table listings add column if not exists phone_normalized text;

-- Индекс — чтобы countListingsByPhone не сканировал всю таблицу на
-- каждое новое объявление (прогон раз в 15 минут, объявлений со
-- временем накопится много).
create index if not exists listings_phone_normalized_idx on listings (phone_normalized);
