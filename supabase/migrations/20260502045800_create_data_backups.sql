-- Ensure the localStorage cloud backup table supports one backup row per user.
-- This fixes PostgREST errors from `on_conflict=user_id` when the table lacks
-- a unique constraint, and from backup reads expecting a created_at column.

create extension if not exists pgcrypto;

create table if not exists public.data_backups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  backup_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.data_backups
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists backup_data jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

update public.data_backups
set id = gen_random_uuid()
where id is null;

update public.data_backups
set backup_data = '{}'::jsonb
where backup_data is null;

update public.data_backups
set created_at = now()
where created_at is null;

delete from public.data_backups
where user_id is null;

-- Keep only the newest historical backup for each user before adding uniqueness.
delete from public.data_backups old_row
using public.data_backups newer_row
where old_row.user_id = newer_row.user_id
  and (
    old_row.created_at < newer_row.created_at
    or (
      old_row.created_at = newer_row.created_at
      and old_row.ctid < newer_row.ctid
    )
  );

alter table public.data_backups
  alter column id set not null,
  alter column user_id set not null,
  alter column backup_data set not null,
  alter column created_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.data_backups'::regclass
      and contype = 'p'
  ) then
    alter table public.data_backups
      add constraint data_backups_pkey primary key (id);
  end if;
end $$;

create unique index if not exists data_backups_user_id_key
  on public.data_backups(user_id);

alter table public.data_backups enable row level security;

drop policy if exists "Users can read their data backup" on public.data_backups;
drop policy if exists "Users can insert their data backup" on public.data_backups;
drop policy if exists "Users can update their data backup" on public.data_backups;
drop policy if exists "Users can delete their data backup" on public.data_backups;

create policy "Users can read their data backup"
  on public.data_backups
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert their data backup"
  on public.data_backups
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update their data backup"
  on public.data_backups
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their data backup"
  on public.data_backups
  for delete
  to authenticated
  using (auth.uid() = user_id);
