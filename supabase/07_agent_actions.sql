-- Выполнить один раз в Supabase SQL Editor.
-- Нужно для новых кнопок "✅ Связался" / "👤 Беру в работу" прямо в
-- Telegram-сообщении с объявлением — раньше "связался" можно было
-- отметить только на сайте, а "кто взял в работу" не отслеживалось
-- вообще. Теперь оба действия сохраняются в базе и видны и в
-- Telegram (сообщение само обновляется), и на сайте.

alter table listings add column if not exists assigned_to text;      -- кто взял объявление в работу (имя/username из Telegram)
alter table listings add column if not exists assigned_at timestamptz;
alter table listings add column if not exists contacted_by text;     -- кто отметил "связался" (Telegram-имя или email с сайта)
alter table listings add column if not exists contacted_at timestamptz;
