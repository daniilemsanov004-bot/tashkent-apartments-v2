-- Разовая чистка: OLX-баг протекал CSS-текстом (".css-1f8vyal{...}")
-- прямо в raw_text у уже сохранённых объявлений (см. фикс в
-- scraper/src/scrapers/olx.js + client/src/App.jsx). Сам источник бага
-- починен, но старые строки в базе это не переписывает — прогнать один
-- раз в Supabase: Project → SQL Editor → New query → вставить и Run.
--
-- Клиент (App.jsx) уже чистит это на отображении, так что запускать
-- необязательно — но без этого мусор так и останется в самих данных
-- (например, если раздавать raw_text куда-то ещё, кроме сайта).

update listings
set raw_text = trim(regexp_replace(raw_text, '\.css-[\w-]+\s*\{[^{}]*\}?', ' ', 'g'))
where raw_text ~ '\.css-[\w-]+\s*\{';
