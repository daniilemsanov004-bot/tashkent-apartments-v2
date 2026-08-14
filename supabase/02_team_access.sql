-- Выполнить в Supabase SQL Editor.
-- Добавляет систему доступа: только те, кто в team_members, могут
-- входить и видеть объявления. Любой уже добавленный человек может
-- пригласить нового (добавить его email в эту таблицу).

create table if not exists team_members (
  email text primary key,
  added_by text,
  -- 'owner' — может приглашать, менять роли и удалять; 'admin' — обычный
  -- участник команды, видит список, но не управляет им. Обычных
  -- участников (без права даже видеть список) пока не вводим.
  role text not null default 'admin' check (role in ('owner', 'admin')),
  created_at timestamptz default now()
);

-- RLS без разрешающих политик = запрет на прямой доступ через анонимный
-- ключ. Иначе кто угодно с anon-ключом (он публичен, лежит в JS-бандле)
-- мог бы вставить свою почту в эту таблицу с ролью owner и обойти всю
-- систему авторизации сайта. Доступ — только через service_role в /api.
alter table team_members enable row level security;

-- Впишите СВОЙ email — тот, которым будете входить первым. Именно он
-- становится владельцем (role = 'owner') — только владелец может
-- приглашать людей и назначать роли. Без этой строки войти будет
-- некому, даже вам.
insert into team_members (email, added_by, role)
values ('ваш-email@пример.com', 'initial', 'owner')
on conflict (email) do nothing;

-- ВАЖНО: см. также migration_fix_rls_security.sql — он закрывает
-- публичную политику чтения на listings, которая была включена по
-- ошибке (см. историю миграций).
