-- Plates schema
--
-- Lives inside the *recipes* Supabase project. Nothing in this file may touch
-- public.* — that is the recipes app, used by a third person. See CLAUDE.md.
--
-- After applying, the `plates` schema must be added to the exposed-schemas list
-- in Project Settings → API, or PostgREST will not serve any of it.

create schema if not exists plates;

-- ============================================================================
-- Membership
-- ============================================================================
-- Deliberately mirrors public.is_editor() / public.is_admin(). Plates policies
-- must never reference public.allowed_emails, and vice versa: that separation is
-- what keeps Plates invisible to the recipes app's third member.

create table if not exists plates.members (
  email        text primary key,
  display_name text,
  weight_unit  text    not null default 'lb' check (weight_unit in ('lb','kg')),
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

create or replace function plates.is_member() returns boolean
  language sql security definer stable set search_path = ''
as $$
  select exists (
    select 1 from plates.members
    where lower(email) = lower(coalesce(auth.email(), ''))
  );
$$;

create or replace function plates.is_admin() returns boolean
  language sql security definer stable set search_path = ''
as $$
  select exists (
    select 1 from plates.members
    where lower(email) = lower(coalesce(auth.email(), '')) and is_admin
  );
$$;

-- Opt-in mutual visibility. A grant is one-directional; both rows exist when two
-- people can see each other.
create table if not exists plates.share_grants (
  grantor_email text not null,
  grantee_email text not null,
  created_at    timestamptz not null default now(),
  primary key (grantor_email, grantee_email)
);

create or replace function plates.is_owner(row_owner text) returns boolean
  language sql stable set search_path = ''
as $$
  select lower(coalesce(row_owner, '')) = lower(coalesce(auth.email(), ''));
$$;

-- Readable if you own it, or its owner has granted you access.
create or replace function plates.can_read(row_owner text) returns boolean
  language sql security definer stable set search_path = ''
as $$
  select plates.is_member() and (
    lower(coalesce(row_owner, '')) = lower(coalesce(auth.email(), ''))
    or exists (
      select 1 from plates.share_grants g
      where lower(g.grantor_email) = lower(coalesce(row_owner, ''))
        and lower(g.grantee_email) = lower(coalesce(auth.email(), ''))
    )
  );
$$;

-- ============================================================================
-- Food
-- ============================================================================
-- owner_email null means a shared lookup-cache row: a product one person scanned
-- becomes available to the other. All macro values are per serving.

create table if not exists plates.foods (
  id            uuid primary key default gen_random_uuid(),
  owner_email   text default auth.email(),
  barcode       text,
  name          text not null,
  brand         text,
  serving_qty   numeric not null default 100,
  serving_unit  text    not null default 'g',
  -- How much you normally eat, which is NOT the basis the macros are stored
  -- against. OFF publishes nutriments per 100 g for most products but also
  -- publishes the label serving; serving_qty has to stay consistent with the
  -- macros, so the serving gets its own column. Null falls back to serving_qty.
  default_qty   numeric,
  -- What one serving physically measures, in its own unit — 170 g of yoghurt,
  -- 355 ml of soda. `serving_unit` is usually the word 'serving' and says
  -- nothing about size, so this is the only thing that makes servings and a
  -- weight interconvertible. Null where the source never published it.
  serving_size      numeric,
  serving_size_unit text,
  calories      numeric,
  protein_g     numeric,
  carbs_g       numeric,
  fat_g         numeric,
  fiber_g       numeric,
  sodium_mg     numeric,
  source        text check (source in ('off','usda','fatsecret','manual','label_photo')),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- Macro columns here are a SNAPSHOT taken at log time, not a live reference.
-- food_id and recipe_id are provenance only — this is what makes it safe to
-- point at public.recipes, which a third person can edit at any time.
create table if not exists plates.food_log (
  id           uuid primary key default gen_random_uuid(),
  owner_email  text not null default auth.email(),
  logged_at    timestamptz not null default now(),
  meal_slot    text check (meal_slot in ('breakfast','lunch','dinner','snack')),
  food_id      uuid   references plates.foods(id) on delete set null,
  recipe_id    bigint,                      -- public.recipes(id), intentionally not an FK
  description  text not null,
  quantity     numeric not null,
  unit         text    not null,
  calories     numeric,
  protein_g    numeric,
  carbs_g      numeric,
  fat_g        numeric,
  fiber_g      numeric,
  sodium_mg    numeric,
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create table if not exists plates.weight_log (
  id          uuid primary key default gen_random_uuid(),
  owner_email text not null default auth.email(),
  measured_at timestamptz not null default now(),
  weight_lb   numeric not null,
  note        text,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- One-tap "my usual breakfast". Items are denormalised on purpose: a combo is a
-- shortcut, not a relationship worth maintaining.
create table if not exists plates.meal_combos (
  id          uuid primary key default gen_random_uuid(),
  owner_email text not null default auth.email(),
  name        text not null,
  items       jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Targets, as dated phases rather than columns on members. A bulk and a cut
-- carry different calories, macros and goal weight, so overwriting one set of
-- columns would destroy the history of what you were actually aiming for.
-- The current goal is the latest row whose window contains today.
create table if not exists plates.goals (
  id               uuid primary key default gen_random_uuid(),
  owner_email      text not null default auth.email(),
  phase            text check (phase in ('bulk','cut','maintain')),
  starts_on        date not null default current_date,
  ends_on          date,                     -- null = still current
  calorie_target   numeric,
  protein_target_g numeric,
  carbs_target_g   numeric,
  fat_target_g     numeric,
  target_weight_lb numeric,
  notes            text,
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

-- A saved day, for meal prep. Entries are snapshotted exactly like food_log:
-- applying a template months from now must not depend on the food still
-- existing or still carrying the same macros.
create table if not exists plates.day_templates (
  id          uuid primary key default gen_random_uuid(),
  owner_email text not null default auth.email(),
  name        text not null,
  items       jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- ============================================================================
-- Workouts
-- ============================================================================
-- owner_email null means a row from the shared Free Exercise DB import.

create table if not exists plates.exercises (
  id                uuid primary key default gen_random_uuid(),
  owner_email       text default auth.email(),
  name              text not null,
  primary_muscle    text,
  secondary_muscles text[] not null default '{}',
  equipment         text,
  category          text,
  instructions      jsonb  not null default '[]'::jsonb,
  image_urls        text[] not null default '{}',
  external_id       text,
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create table if not exists plates.routines (
  id          uuid primary key default gen_random_uuid(),
  owner_email text not null default auth.email(),
  name        text not null,
  notes       text,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists plates.routine_exercises (
  id               uuid primary key default gen_random_uuid(),
  owner_email      text not null default auth.email(),
  routine_id       uuid not null references plates.routines(id) on delete cascade,
  exercise_id      uuid references plates.exercises(id) on delete set null,
  position         integer not null default 0,
  target_sets      integer,
  target_reps      text,
  target_weight_lb numeric,
  rest_seconds     integer,
  notes            text,
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create table if not exists plates.sessions (
  id          uuid primary key default gen_random_uuid(),
  owner_email text not null default auth.email(),
  routine_id  uuid references plates.routines(id) on delete set null,
  name        text,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  notes       text,
  -- When the "you left this running" reminder was last pushed for this session.
  -- Stops the five-minute cron sending the same nudge on every pass.
  idle_notified_at timestamptz,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Server-side configuration, so nothing has to be pasted into a dashboard.
--
-- Three values live here, separated by `is_public`:
--   vapid_public_key   — public by definition; the browser needs it to subscribe
--   vapid_private_key  — signs push requests; must never leave the server
--   cron_secret        — proves the scheduler is the caller
--
-- The keypair is generated by the notify-idle-workouts function on the first run
-- that finds none. That is deliberate: the first version of this had the keys
-- generated locally and set as function secrets by hand, and the only copy of
-- the private half was lost with a temp file, which silently made every existing
-- subscription undeliverable.
--
-- Members can read public rows and nothing else. There is no insert or update
-- policy at all, which is a deny — the function reaches this with the service
-- role, which bypasses RLS.
create table if not exists plates.app_config (
  key        text primary key,
  value      text not null,
  is_public  boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Web Push endpoints, one row per browser that opted in to idle reminders.
--
-- The one table that is NOT synced to IndexedDB: a subscription belongs to a
-- single installed browser and is meaningless on any other device, so there is
-- nothing to sync and nothing worth having offline.
--
-- An endpoint is a capability to send someone a notification, so the policy is
-- scoped to the owner as well as to membership.
create table if not exists plates.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  owner_email text not null default auth.email(),
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  -- Set when a push comes back 404/410: the browser dropped the subscription
  -- and the endpoint must not be retried forever.
  failed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- exercise_name is snapshotted for the same reason food_log snapshots macros:
-- renaming or deleting a custom exercise must not corrupt training history.
create table if not exists plates.session_sets (
  id            uuid primary key default gen_random_uuid(),
  owner_email   text not null default auth.email(),
  session_id    uuid not null references plates.sessions(id) on delete cascade,
  exercise_id   uuid references plates.exercises(id) on delete set null,
  exercise_name text not null,
  set_index     integer not null default 0,
  weight_lb     numeric,
  reps          integer,
  rpe           numeric,
  is_warmup     boolean not null default false,
  completed_at  timestamptz,
  -- Stamped on sets left behind when the exercise was replaced mid-workout.
  -- They still count for volume, history and records — you lifted them — but
  -- "update the routine from this session" leaves the card out, because a
  -- replace means you switched away from it deliberately.
  replaced_at   timestamptz,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- ============================================================================
-- Indexes
-- ============================================================================

create index if not exists food_log_owner_time_idx  on plates.food_log     (owner_email, logged_at desc);
create index if not exists food_log_food_idx        on plates.food_log     (food_id);
create index if not exists foods_barcode_idx        on plates.foods        (barcode) where barcode is not null;
create index if not exists foods_owner_idx          on plates.foods        (owner_email);
create index if not exists weight_owner_time_idx    on plates.weight_log   (owner_email, measured_at desc);
create index if not exists goals_owner_start_idx    on plates.goals        (owner_email, starts_on desc);
create index if not exists day_templates_owner_idx  on plates.day_templates (owner_email);
create index if not exists sessions_owner_time_idx  on plates.sessions     (owner_email, started_at desc);
create index if not exists session_sets_session_idx on plates.session_sets (session_id);
create index if not exists routine_ex_routine_idx   on plates.routine_exercises (routine_id);
create index if not exists push_subs_owner_idx       on plates.push_subscriptions (owner_email);
create index if not exists exercises_name_idx       on plates.exercises    (lower(name));

-- Sync pulls everything changed since the last cursor.
create index if not exists food_log_sync_idx     on plates.food_log     (updated_at);
create index if not exists goals_sync_idx        on plates.goals        (updated_at);
create index if not exists day_templates_sync_idx on plates.day_templates (updated_at);
create index if not exists foods_sync_idx        on plates.foods        (updated_at);
create index if not exists session_sets_sync_idx on plates.session_sets (updated_at);

-- ============================================================================
-- Row level security
-- ============================================================================
-- Read: own rows, plus rows whose owner granted you access.
-- Write: own rows only.
-- Shared reference rows (owner_email null) are readable and writable by any
-- member — that is the barcode cache and the imported exercise library.

alter table plates.members           enable row level security;
alter table plates.share_grants      enable row level security;
alter table plates.foods             enable row level security;
alter table plates.food_log          enable row level security;
alter table plates.weight_log        enable row level security;
alter table plates.meal_combos       enable row level security;
alter table plates.goals             enable row level security;
alter table plates.day_templates     enable row level security;
alter table plates.exercises         enable row level security;
alter table plates.routines          enable row level security;
alter table plates.routine_exercises enable row level security;
alter table plates.sessions          enable row level security;
alter table plates.session_sets      enable row level security;
alter table plates.push_subscriptions enable row level security;
alter table plates.app_config        enable row level security;

-- Postgres has no CREATE POLICY IF NOT EXISTS, so every policy is dropped first.
-- That keeps this file re-runnable as the source of truth.

-- members: everyone in the club can see who else is in it; only admins edit.
drop policy if exists members_read         on plates.members;
drop policy if exists members_self         on plates.members;
drop policy if exists members_admin_insert on plates.members;
drop policy if exists members_admin_delete on plates.members;

create policy members_read   on plates.members for select using (plates.is_member());
create policy members_self   on plates.members for update
  using (plates.is_owner(email)) with check (plates.is_owner(email));
create policy members_admin_insert on plates.members for insert with check (plates.is_admin());
create policy members_admin_delete on plates.members for delete using (plates.is_admin());

-- share_grants: you can see and manage grants you are party to.
drop policy if exists grants_read   on plates.share_grants;
drop policy if exists grants_insert on plates.share_grants;
drop policy if exists grants_delete on plates.share_grants;

create policy grants_read on plates.share_grants for select
  using (plates.is_member() and (plates.is_owner(grantor_email) or plates.is_owner(grantee_email)));
create policy grants_insert on plates.share_grants for insert
  with check (plates.is_owner(grantor_email));
create policy grants_delete on plates.share_grants for delete
  using (plates.is_owner(grantor_email) or plates.is_owner(grantee_email));

-- Owner-scoped tables. Same three policies each.
do $$
declare t text;
begin
  foreach t in array array[
    'food_log','weight_log','meal_combos','goals','day_templates',
    'routines','routine_exercises','sessions','session_sets'
  ] loop
    execute format('drop policy if exists %1$s_read   on plates.%1$I', t);
    execute format('drop policy if exists %1$s_write  on plates.%1$I', t);
    execute format('drop policy if exists %1$s_update on plates.%1$I', t);
    execute format('drop policy if exists %1$s_delete on plates.%1$I', t);
    execute format(
      'create policy %1$s_read on plates.%1$I for select using (plates.can_read(owner_email))', t);
    execute format(
      'create policy %1$s_write on plates.%1$I for insert with check (plates.is_member() and plates.is_owner(owner_email))', t);
    execute format(
      'create policy %1$s_update on plates.%1$I for update using (plates.is_owner(owner_email)) with check (plates.is_owner(owner_email))', t);
    execute format(
      'create policy %1$s_delete on plates.%1$I for delete using (plates.is_owner(owner_email))', t);
  end loop;
end $$;

-- app_config: public rows readable by members; everything else server-only.
drop policy if exists app_config_public_read on plates.app_config;

create policy app_config_public_read on plates.app_config
  for select using (is_public and plates.is_member());

-- push_subscriptions: strictly your own, not shared.
--
-- Deliberately owner_email = auth.email() rather than can_read(), which the
-- other owner-scoped tables use. can_read() honours share_grants, and while
-- letting someone see your weight log is the point of sharing, letting them see
-- — or delete — the endpoints that can push to your phone is not.
drop policy if exists push_subs_own on plates.push_subscriptions;

create policy push_subs_own on plates.push_subscriptions
  for all
  using (plates.is_member() and owner_email = auth.email())
  with check (plates.is_member() and owner_email = auth.email());

-- Tables with a shared (null-owner) tier.
do $$
declare t text;
begin
  foreach t in array array['foods','exercises'] loop
    execute format('drop policy if exists %1$s_read   on plates.%1$I', t);
    execute format('drop policy if exists %1$s_write  on plates.%1$I', t);
    execute format('drop policy if exists %1$s_update on plates.%1$I', t);
    execute format('drop policy if exists %1$s_delete on plates.%1$I', t);
    execute format(
      'create policy %1$s_read on plates.%1$I for select using ((owner_email is null and plates.is_member()) or plates.can_read(owner_email))', t);
    execute format(
      'create policy %1$s_write on plates.%1$I for insert with check (plates.is_member() and (owner_email is null or plates.is_owner(owner_email)))', t);
    execute format(
      'create policy %1$s_update on plates.%1$I for update using (plates.is_member() and (owner_email is null or plates.is_owner(owner_email))) with check (plates.is_member() and (owner_email is null or plates.is_owner(owner_email)))', t);
    execute format(
      'create policy %1$s_delete on plates.%1$I for delete using (plates.is_owner(owner_email))', t);
  end loop;
end $$;

-- ============================================================================
-- Grants
-- ============================================================================
-- RLS is only half of it: without table privileges PostgREST's role cannot
-- reach these tables at all. anon is deliberately given nothing.

grant usage on schema plates to authenticated;
grant select, insert, update, delete on all tables in schema plates to authenticated;
grant execute on all functions in schema plates to authenticated;

-- Edge Functions come in as service_role, which bypasses RLS but *not* table
-- privileges. Without this the idle-workout function failed on its first read
-- with "permission denied for schema plates", which no amount of configuration
-- would have fixed.
grant usage on schema plates to service_role;
grant select, insert, update, delete on all tables in schema plates to service_role;
grant execute on all functions in schema plates to service_role;

alter default privileges in schema plates
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema plates
  grant execute on functions to authenticated;

alter default privileges in schema plates
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema plates
  grant execute on functions to service_role;
