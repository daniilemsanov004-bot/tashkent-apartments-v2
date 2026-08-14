-- Картинка объявления (og:image со страницы OLX/Realting, media из API Uybor).
-- Выполнить один раз в Supabase → SQL Editor.
alter table listings add column if not exists image_url text;
