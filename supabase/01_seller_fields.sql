-- Выполнить ОДИН РАЗ в Supabase SQL Editor, если таблица listings
-- уже была создана раньше (иначе саму schema.sql заново запускать
-- не нужно — create table if not exists её не тронет).

alter table listings add column if not exists seller_name text;
alter table listings add column if not exists seller_listings_count integer;
