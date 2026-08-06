-- Выполнить в Supabase SQL Editor (для УЖЕ существующей установки,
-- где таблица team_members создана без роли — см. migration_team_access.sql).
-- Если ставите систему с нуля — role уже заложена в
-- migration_team_access.sql, этот файл не нужен.

alter table team_members
  add column if not exists role text not null default 'admin'
  check (role in ('owner', 'admin'));

-- Первый человек, кто был добавлен в команду (по created_at),
-- становится владельцем — если владельца ещё нет вообще.
-- Если у вас уже есть конкретный email, который должен быть
-- владельцем, надёжнее выполнить вручную:
--   update team_members set role = 'owner' where email = 'ваш-email@пример.com';
do $$
begin
  if not exists (select 1 from team_members where role = 'owner') then
    update team_members
    set role = 'owner'
    where email = (select email from team_members order by created_at asc limit 1);
  end if;
end $$;
