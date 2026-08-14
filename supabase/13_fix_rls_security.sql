-- Выполнить ОДИН РАЗ в Supabase SQL Editor (Project → SQL Editor → New query → Run).
--
-- Закрывает две дыры в безопасности, актуальные для уже созданной базы
-- (schema.sql и migration_team_access.sql в старом виде их не покрывают,
-- т.к. применяются только при первой установке):
--
-- 1. На listings была публичная политика чтения ("Публичное чтение",
--    for select using (true)). Анонимный ключ Supabase публично лежит
--    в JS-бандле сайта, так что любой, кто его достанет, мог напрямую
--    читать все объявления (включая телефоны продавцов) через Supabase
--    REST API, в обход входа по email.
--
-- 2. На team_members и bot_sessions RLS вообще не был включён. По
--    умолчанию Supabase даёт роли anon права на чтение/запись в
--    public-схему — то есть кто угодно с анонимным ключом теоретически
--    мог вставить свою почту в team_members с ролью owner напрямую
--    через REST API, полностью обойдя авторизацию сайта.

-- 1. Убираем публичное чтение listings.
drop policy if exists "Публичное чтение" on listings;

-- На случай, если RLS ещё не был включён.
alter table listings enable row level security;

-- 2. Включаем RLS на team_members и bot_sessions без разрешающих
--    политик — это запрещает прямой доступ через анонимный ключ.
--    Весь легитимный доступ идёт через /api (Vercel), который
--    использует service_role ключ и RLS не касается.
alter table team_members enable row level security;
alter table bot_sessions enable row level security;

-- 3. На всякий случай явно забираем дефолтные права у ролей anon и
--    authenticated на схему public — так безопасность не будет
--    держаться только на RLS-политиках (или их отсутствии), а будет
--    подкреплена и на уровне грантов.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

-- Проверка после выполнения (не обязательно, но полезно):
-- select tablename, rowsecurity from pg_tables where schemaname = 'public';
-- select * from pg_policies where schemaname = 'public';
-- В первом запросе rowsecurity должно быть true у listings, team_members,
-- bot_sessions. Во втором — не должно остаться политик на listings.
