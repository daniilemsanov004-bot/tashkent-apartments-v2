-- Выполнить один раз в Supabase SQL Editor.
-- Нужно для новых кнопок "🚫 Это агент" и "📝 Заметка" на карточках
-- объявлений в Telegram.

alter table listings add column if not exists flagged_agent boolean default false; -- агент вручную пометил как "на самом деле агентство"
alter table listings add column if not exists flagged_by text;
alter table listings add column if not exists flagged_at timestamptz;
alter table listings add column if not exists notes text; -- свободная заметка агента ("перезвонить завтра" и т.п.)
