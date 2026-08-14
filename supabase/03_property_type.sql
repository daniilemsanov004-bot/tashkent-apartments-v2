-- Выполнить ОДИН РАЗ в Supabase SQL Editor.
-- Добавляет колонку property_type ('apartment' | 'house' | 'commercial'),
-- нужна для фильтра "квартиры / дома / коммерция" на сайте и в боте.

alter table listings add column if not exists property_type text default 'apartment';
