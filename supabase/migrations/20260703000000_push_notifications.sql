-- Push notification support.
--
-- push_subscriptions: one row per device a user has enabled push on
-- (Web Push endpoint + encryption keys + IANA timezone, used by the
-- send-due-notifications Edge Function to know when "9am" locally means
-- in UTC).
--
-- push_notification_log: dedupe table so the cron job never sends the same
-- task/event reminder twice.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

alter table public.push_subscriptions enable row level security;

create policy "Users manage their own push subscriptions"
  on public.push_subscriptions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.push_notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null,
  sent_at timestamptz not null default now(),
  unique (user_id, item_key)
);

alter table public.push_notification_log enable row level security;
-- No policies on purpose: only the service-role key (used by the
-- send-due-notifications Edge Function) can read/write this table, and the
-- service role bypasses RLS.
