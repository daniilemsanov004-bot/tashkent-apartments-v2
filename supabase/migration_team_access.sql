-- Выполнить в Supabase SQL Editor.
-- Добавляет систему доступа: только те, кто в team_members, могут
-- входить и видеть объявления. Любой уже добавленный человек может
-- пригласить нового (добавить его email в эту таблицу).

create table if not exists team_members (
  email text primary key,
  added_by text,
  created_at timestamptz default now()
);

-- Впишите СВОЙ email — тот, которым будете входить первым.
-- Без этой строки войти будет некому, даже вам.
insert into team_members (email, added_by)
values ('ваш-email@пример.com', 'initial')
on conflict (email) do nothing;

-- RLS на самой таблице listings можно оставить как есть — доступ к
-- данным контролируется на уровне наших /api serverless-функций
-- (они проверяют токен и членство в team_members перед ответом),
-- а не напрямую через Supabase, так что дополнительные политики
-- на listings не обязательны.
