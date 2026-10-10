-- ============================================================================
-- SKY HOPPER: FLIGHT CLUB — COMPLETE SUPABASE DATABASE
-- ============================================================================
-- Paste this entire file into Supabase Dashboard > SQL Editor > New query and run.
--
-- Supports the current Sky Hopper Flight Club website:
--   * Supabase Auth-backed accounts and player profiles
--   * Public best-score leaderboard
--   * Player stats, XP, levels, lifetime points, and coins
--   * 1,000 achievement definitions and cloud unlock records
--   * 120 ability/relic definitions across six rarity tiers
--   * Cloud inventory, upgrade catalogue, and purchased upgrades
--   * Cloud flight history
--   * Atomic RPCs: submit_run, collect_ability_item, purchase_upgrade
--   * Row Level Security and restricted client write permissions
--
-- This script is designed to be re-runnable on a project using the previous
-- Sky Hopper schema. Back up important data before changing a production DB.
-- It does not configure frontend keys, Auth email settings, or prove that a
-- client-submitted game score is honest. Do not put service-role keys in a browser.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Core player data
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,16}$'),
  best_score integer not null default 0 check (best_score >= 0),
  xp bigint not null default 0 check (xp >= 0),
  level integer not null default 1 check (level >= 1),
  updated_at timestamptz not null default pg_catalog.now()
);

-- Make sure a previous installation has all columns used by the current client.
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists best_score integer not null default 0;
alter table public.profiles add column if not exists xp bigint not null default 0;
alter table public.profiles add column if not exists level integer not null default 1;
alter table public.profiles add column if not exists updated_at timestamptz not null default pg_catalog.now();

-- Widen XP to avoid overflow as progression grows on older installations.
alter table public.profiles alter column xp type bigint using xp::bigint;

create unique index if not exists profiles_username_key on public.profiles(username);
create index if not exists profiles_leaderboard_idx on public.profiles(best_score desc, updated_at asc);

create table if not exists public.player_stats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  games_played bigint not null default 0 check (games_played >= 0),
  coins bigint not null default 0 check (coins >= 0),
  lifetime_score bigint not null default 0 check (lifetime_score >= 0),
  arcade_score bigint not null default 0 check (arcade_score >= 0),
  items_collected bigint not null default 0 check (items_collected >= 0),
  rare_items bigint not null default 0 check (rare_items >= 0),
  upgrades_purchased bigint not null default 0 check (upgrades_purchased >= 0),
  last_item_claimed_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now()
);

alter table public.player_stats add column if not exists games_played bigint not null default 0;
alter table public.player_stats add column if not exists coins bigint not null default 0;
alter table public.player_stats add column if not exists lifetime_score bigint not null default 0;
alter table public.player_stats add column if not exists arcade_score bigint not null default 0;
alter table public.player_stats add column if not exists items_collected bigint not null default 0;
alter table public.player_stats add column if not exists rare_items bigint not null default 0;
alter table public.player_stats add column if not exists upgrades_purchased bigint not null default 0;
alter table public.player_stats add column if not exists last_item_claimed_at timestamptz;
alter table public.player_stats add column if not exists updated_at timestamptz not null default pg_catalog.now();

-- Widen lifetime counters on older installs while preserving current values.
alter table public.player_stats alter column games_played type bigint using games_played::bigint;
alter table public.player_stats alter column coins type bigint using coins::bigint;
alter table public.player_stats alter column lifetime_score type bigint using lifetime_score::bigint;
alter table public.player_stats alter column arcade_score type bigint using arcade_score::bigint;
alter table public.player_stats alter column items_collected type bigint using items_collected::bigint;
alter table public.player_stats alter column rare_items type bigint using rare_items::bigint;
alter table public.player_stats alter column upgrades_purchased type bigint using upgrades_purchased::bigint;

create table if not exists public.user_achievements (
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_code text not null,
  unlocked_at timestamptz not null default pg_catalog.now(),
  primary key (user_id, achievement_code)
);

-- Older versions restricted achievement_code to seven starter achievements.
-- Remove that legacy CHECK so all 1,000 catalogue achievements can be recorded.
do $do$
declare v_constraint record;
begin
  for v_constraint in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.user_achievements'::pg_catalog.regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) ilike '%achievement_code%'
  loop
    execute pg_catalog.format('alter table public.user_achievements drop constraint %I', v_constraint.conname);
  end loop;
end
$do$;

-- ---------------------------------------------------------------------------
-- 2. Public catalogues
-- ---------------------------------------------------------------------------
create table if not exists public.achievement_catalog (
  code text primary key,
  title text not null,
  description text not null,
  category text not null check (category in ('score','flights','items','rare','arcade','upgrades')),
  target bigint not null check (target > 0),
  sort_order integer not null unique
);

-- Exactly 1,000 definitions across six progression categories.
insert into public.achievement_catalog(code, title, description, category, target, sort_order)
select 'score_' || pg_catalog.lpad(n::text, 3, '0'),
       'Gate Runner ' || pg_catalog.lpad(n::text, 3, '0'),
       'Reach a best score of ' || target::text || '.', 'score', target, n
from (
  select n,
    case when n <= 20 then n
         when n <= 50 then 20 + (n - 20) * 5
         when n <= 100 then 170 + (n - 50) * 10
         when n <= 150 then 670 + (n - 100) * 25
         else 1920 + (n - 150) * 50 end::bigint as target
  from generate_series(1, 200) as g(n)
) q
on conflict (code) do update set title=excluded.title, description=excluded.description,
  category=excluded.category, target=excluded.target, sort_order=excluded.sort_order;

insert into public.achievement_catalog(code, title, description, category, target, sort_order)
select 'flights_' || pg_catalog.lpad(n::text, 3, '0'),
       'Sky Traveller ' || pg_catalog.lpad(n::text, 3, '0'),
       'Complete ' || target::text || ' flights.', 'flights', target, 200 + n
from (
  select n,
    case when n <= 25 then n
         when n <= 100 then 25 + (n - 25) * 4
         when n <= 150 then 325 + (n - 100) * 10
         else 825 + (n - 150) * 25 end::bigint as target
  from generate_series(1, 200) as g(n)
) q
on conflict (code) do update set title=excluded.title, description=excluded.description,
  category=excluded.category, target=excluded.target, sort_order=excluded.sort_order;

insert into public.achievement_catalog(code, title, description, category, target, sort_order)
select 'items_' || pg_catalog.lpad(n::text, 3, '0'),
       'Curio Collector ' || pg_catalog.lpad(n::text, 3, '0'),
       'Collect ' || target::text || ' flight relics.', 'items', target, 400 + n
from (
  select n,
    case when n <= 25 then n
         when n <= 75 then 25 + (n - 25) * 5
         when n <= 125 then 275 + (n - 75) * 20
         else 1275 + (n - 125) * 50 end::bigint as target
  from generate_series(1, 200) as g(n)
) q
on conflict (code) do update set title=excluded.title, description=excluded.description,
  category=excluded.category, target=excluded.target, sort_order=excluded.sort_order;

insert into public.achievement_catalog(code, title, description, category, target, sort_order)
select 'rare_' || pg_catalog.lpad(n::text, 3, '0'),
       'Star Seeker ' || pg_catalog.lpad(n::text, 3, '0'),
       'Collect ' || target::text || ' rare-or-better relics.', 'rare', target, 600 + n
from (
  select n,
    case when n <= 10 then n
         when n <= 40 then 10 + (n - 10) * 3
         when n <= 100 then 100 + (n - 40) * 10
         else 700 + (n - 100) * 30 end::bigint as target
  from generate_series(1, 150) as g(n)
) q
on conflict (code) do update set title=excluded.title, description=excluded.description,
  category=excluded.category, target=excluded.target, sort_order=excluded.sort_order;

insert into public.achievement_catalog(code, title, description, category, target, sort_order)
select 'arcade_' || pg_catalog.lpad(n::text, 3, '0'),
       'Arcade Voyager ' || pg_catalog.lpad(n::text, 3, '0'),
       'Earn ' || target::text || ' total Arcade points.', 'arcade', target, 750 + n
from (
  select n,
    case when n <= 25 then n
         when n <= 75 then 25 + (n - 25) * 5
         when n <= 125 then 275 + (n - 75) * 20
         else 1275 + (n - 125) * 50 end::bigint as target
  from generate_series(1, 150) as g(n)
) q
on conflict (code) do update set title=excluded.title, description=excluded.description,
  category=excluded.category, target=excluded.target, sort_order=excluded.sort_order;

insert into public.achievement_catalog(code, title, description, category, target, sort_order)
select 'upgrades_' || pg_catalog.lpad(n::text, 3, '0'),
       'Tinker Pilot ' || pg_catalog.lpad(n::text, 3, '0'),
       'Purchase ' || target::text || ' upgrades.', 'upgrades', target, 900 + n
from (
  select n,
    case when n <= 10 then n
         when n <= 30 then 10 + (n - 10) * 2
         when n <= 60 then 50 + (n - 30) * 5
         else 200 + (n - 60) * 10 end::bigint as target
  from generate_series(1, 100) as g(n)
) q
on conflict (code) do update set title=excluded.title, description=excluded.description,
  category=excluded.category, target=excluded.target, sort_order=excluded.sort_order;

create table if not exists public.ability_catalog (
  code text primary key,
  name text not null,
  rarity text not null check (rarity in ('common','uncommon','rare','epic','legendary','mythic')),
  item_type text not null check (item_type in ('shield','slow','heal','magnet','gust','score','ward','time')),
  power integer not null check (power between 1 and 10),
  drop_chance_percent numeric(7,4) not null check (drop_chance_percent > 0 and drop_chance_percent <= 100)
);

-- 120 collectible variants. The per-item weights sum to 100% across all rows.
insert into public.ability_catalog(code, name, rarity, item_type, power, drop_chance_percent)
select 'ability_' || pg_catalog.lpad(n::text, 3, '0'),
       rarity_name || ' ' || type_name || ' ' || pg_catalog.lpad(n::text, 3, '0'),
       rarity, item_type,
       least(10, 1 + tier * 2 + ((position_in_tier - 1) % 4)),
       case rarity
         when 'common' then 48.0 / 40
         when 'uncommon' then 28.0 / 30
         when 'rare' then 15.0 / 22
         when 'epic' then 6.5 / 16
         when 'legendary' then 2.0 / 8
         else 0.5 / 4
       end
from (
  select n,
    case when n <= 40 then 'common' when n <= 70 then 'uncommon'
         when n <= 92 then 'rare' when n <= 108 then 'epic'
         when n <= 116 then 'legendary' else 'mythic' end as rarity,
    case when n <= 40 then 'Common' when n <= 70 then 'Uncommon'
         when n <= 92 then 'Rare' when n <= 108 then 'Epic'
         when n <= 116 then 'Legendary' else 'Mythic' end as rarity_name,
    case mod(n - 1, 8) when 0 then 'shield' when 1 then 'slow' when 2 then 'heal'
      when 3 then 'magnet' when 4 then 'gust' when 5 then 'score'
      when 6 then 'ward' else 'time' end as item_type,
    case mod(n - 1, 8) when 0 then 'Aegis' when 1 then 'Hourglass' when 2 then 'Heart'
      when 3 then 'Magnet' when 4 then 'Gust' when 5 then 'Star'
      when 6 then 'Ward' else 'Time Shard' end as type_name,
    case when n <= 40 then 0 when n <= 70 then 1 when n <= 92 then 2
         when n <= 108 then 3 when n <= 116 then 4 else 5 end as tier,
    case when n <= 40 then n when n <= 70 then n - 40 when n <= 92 then n - 70
         when n <= 108 then n - 92 when n <= 116 then n - 108 else n - 116 end as position_in_tier
  from generate_series(1, 120) as g(n)
) q
on conflict (code) do update set name=excluded.name, rarity=excluded.rarity,
  item_type=excluded.item_type, power=excluded.power,
  drop_chance_percent=excluded.drop_chance_percent;

create table if not exists public.upgrade_catalog (
  code text primary key,
  name text not null,
  description text not null,
  base_price integer not null check (base_price between 1 and 100),
  max_level integer not null check (max_level between 1 and 5)
);

insert into public.upgrade_catalog(code, name, description, base_price, max_level) values
  ('shield_core', 'Aegis Tuning', 'Extend Star Shield duration.', 20, 5),
  ('cooldown_coil', 'Quick-Charge Coil', 'Reduce ability cooldowns.', 25, 5),
  ('slow_clock', 'Slow-Sky Dial', 'Keep slow skies active longer.', 25, 5),
  ('heart_vessel', 'Heart Vessel', 'Start Arcade flights with extra health.', 50, 2),
  ('magnet_field', 'Relic Magnet', 'Collect flying relics from farther away.', 20, 5),
  ('rarity_compass', 'Rarity Compass', 'Slightly improve higher-tier drop odds.', 40, 5),
  ('score_lens', 'Comet Lens', 'Every fifth gate can earn a bonus point.', 50, 3),
  ('wind_rider', 'Tailwind Stitching', 'Give collected Gust relics a stronger lift.', 35, 5)
on conflict (code) do update set name=excluded.name, description=excluded.description,
  base_price=excluded.base_price, max_level=excluded.max_level;

-- ---------------------------------------------------------------------------
-- 3. Player inventory, upgrades and flight history
-- ---------------------------------------------------------------------------
create table if not exists public.player_inventory (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_code text not null references public.ability_catalog(code) on delete restrict,
  quantity bigint not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (user_id, item_code)
);

create table if not exists public.player_upgrades (
  user_id uuid not null references auth.users(id) on delete cascade,
  upgrade_code text not null references public.upgrade_catalog(code) on delete restrict,
  level integer not null check (level between 1 and 5),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (user_id, upgrade_code)
);

create table if not exists public.flight_runs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  score integer not null check (score between 0 and 5000),
  mode text not null check (mode in ('classic','arcade')),
  duration_ms integer not null check (duration_ms between 1000 and 1800000),
  damaged boolean not null default false,
  abilities_used integer not null default 0 check (abilities_used between 0 and 3),
  created_at timestamptz not null default pg_catalog.now()
);

create index if not exists player_stats_lifetime_score_idx on public.player_stats(lifetime_score desc);
create index if not exists flight_runs_user_created_idx on public.flight_runs(user_id, created_at desc);
create index if not exists flight_runs_leaderboard_idx on public.flight_runs(score desc, created_at asc);

-- ---------------------------------------------------------------------------
-- 4. Auth profile creation
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_skyhopper_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_username text;
  v_fallback text;
begin
  v_username := pg_catalog.lower(pg_catalog.regexp_replace(
    coalesce(new.raw_user_meta_data ->> 'username', ''), '[^a-zA-Z0-9_]', '', 'g'
  ));

  if pg_catalog.length(v_username) < 3 or pg_catalog.length(v_username) > 16 then
    v_username := 'pilot_' || pg_catalog.left(pg_catalog.replace(new.id::text, '-', ''), 10);
  end if;
  v_fallback := 'pilot_' || pg_catalog.left(pg_catalog.replace(new.id::text, '-', ''), 10);

  begin
    insert into public.profiles(id, username) values (new.id, v_username)
    on conflict (id) do nothing;
  exception when unique_violation then
    insert into public.profiles(id, username) values (new.id, v_fallback)
    on conflict (id) do nothing;
  end;

  insert into public.player_stats(user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$function$;

revoke all on function public.handle_new_skyhopper_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created_skyhopper on auth.users;
create trigger on_auth_user_created_skyhopper
after insert on auth.users
for each row execute function public.handle_new_skyhopper_user();

-- Backfill rows for accounts created before this schema was installed.
-- Usernames are generated from the Auth UUID and therefore don't reveal email addresses.
do $backfill$
declare u record;
begin
  for u in select id from auth.users loop
    insert into public.profiles(id, username)
    values (u.id, 'pilot_' || pg_catalog.left(pg_catalog.replace(u.id::text, '-', ''), 10))
    on conflict (id) do nothing;
    insert into public.player_stats(user_id) values (u.id) on conflict (user_id) do nothing;
  end loop;
end
$backfill$;

-- ---------------------------------------------------------------------------
-- 5. Progression RPC: server-side achievement evaluation
-- ---------------------------------------------------------------------------
create or replace function public.unlock_skyhopper_achievements(p_user_id uuid)
returns text[]
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_metrics jsonb;
  v_new_codes text[] := array[]::text[];
begin
  select pg_catalog.jsonb_build_object(
    'score', p.best_score,
    'flights', s.games_played,
    'items', s.items_collected,
    'rare', s.rare_items,
    'arcade', s.arcade_score,
    'upgrades', s.upgrades_purchased
  )
  into v_metrics
  from public.profiles p
  join public.player_stats s on s.user_id = p.id
  where p.id = p_user_id;

  if v_metrics is null then return v_new_codes; end if;

  with inserted as (
    insert into public.user_achievements(user_id, achievement_code)
    select p_user_id, a.code
    from public.achievement_catalog a
    where a.target <= coalesce((v_metrics ->> a.category)::bigint, 0)
    on conflict (user_id, achievement_code) do nothing
    returning achievement_code
  )
  select coalesce(pg_catalog.array_agg(achievement_code), array[]::text[])
  into v_new_codes
  from inserted;

  return v_new_codes;
end;
$function$;
revoke all on function public.unlock_skyhopper_achievements(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Progression RPC: submit a run and award XP / milestone coins
-- ---------------------------------------------------------------------------
create or replace function public.submit_run(
  p_score integer,
  p_duration_ms integer,
  p_mode text,
  p_damaged boolean,
  p_abilities_used integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_stats public.player_stats%rowtype;
  v_new_lifetime bigint;
  v_coin_gain bigint;
  v_xp_gain bigint;
  v_new_awards text[] := array[]::text[];
begin
  if v_user_id is null then
    raise exception 'Sign in is required to sync a score.' using errcode = '28000';
  end if;
  if p_score is null or p_score < 0 or p_score > 5000 then
    raise exception 'Score is outside the allowed range.' using errcode = '22023';
  end if;
  if p_duration_ms is null or p_duration_ms < 1000 or p_duration_ms > 1800000 then
    raise exception 'Run duration is outside the allowed range.' using errcode = '22023';
  end if;
  if p_score > pg_catalog.ceil(p_duration_ms::numeric / 1000)::integer + 5 then
    raise exception 'Score and run duration do not match.' using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('classic','arcade') then
    raise exception 'Unknown game mode.' using errcode = '22023';
  end if;
  if p_damaged is null or p_abilities_used is null or p_abilities_used < 0 or p_abilities_used > 3 then
    raise exception 'Invalid run details.' using errcode = '22023';
  end if;

  insert into public.profiles(id, username)
  values (v_user_id, 'pilot_' || pg_catalog.left(pg_catalog.replace(v_user_id::text, '-', ''), 10))
  on conflict (id) do nothing;
  insert into public.player_stats(user_id) values (v_user_id) on conflict (user_id) do nothing;

  -- Serialize updates for this player so simultaneous requests cannot double-spend
  -- or calculate milestone rewards from the same old lifetime-score value.
  select * into v_stats from public.player_stats where user_id = v_user_id for update;
  v_new_lifetime := v_stats.lifetime_score + p_score;
  v_coin_gain := (pg_catalog.floor(v_new_lifetime::numeric / 1000) * 10)
               - (pg_catalog.floor(v_stats.lifetime_score::numeric / 1000) * 10);
  v_xp_gain := greatest(10, p_score::bigint * 5);

  update public.profiles
  set best_score = greatest(best_score, p_score),
      xp = xp + v_xp_gain,
      level = pg_catalog.floor(pg_catalog.sqrt((xp + v_xp_gain)::numeric / 100))::integer + 1,
      updated_at = pg_catalog.now()
  where id = v_user_id
  returning * into v_profile;

  update public.player_stats
  set games_played = games_played + 1,
      lifetime_score = v_new_lifetime,
      arcade_score = arcade_score + case when p_mode = 'arcade' then p_score else 0 end,
      coins = coins + v_coin_gain,
      updated_at = pg_catalog.now()
  where user_id = v_user_id
  returning * into v_stats;

  insert into public.flight_runs(user_id, score, mode, duration_ms, damaged, abilities_used)
  values (v_user_id, p_score, p_mode, p_duration_ms, p_damaged, p_abilities_used);

  v_new_awards := public.unlock_skyhopper_achievements(v_user_id);
  return pg_catalog.jsonb_build_object(
    'profile', pg_catalog.to_jsonb(v_profile),
    'stats', pg_catalog.to_jsonb(v_stats),
    'awards', pg_catalog.to_jsonb(v_new_awards),
    'coins_earned', v_coin_gain,
    'xp_earned', v_xp_gain
  );
end;
$function$;
revoke all on function public.submit_run(integer, integer, text, boolean, integer) from public, anon;
grant execute on function public.submit_run(integer, integer, text, boolean, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Progression RPC: collect a relic
-- ---------------------------------------------------------------------------
create or replace function public.collect_ability_item(p_item_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_item public.ability_catalog%rowtype;
  v_stats public.player_stats%rowtype;
  v_new_awards text[] := array[]::text[];
  v_quantity bigint;
begin
  if v_user_id is null then
    raise exception 'Sign in is required to save collected relics.' using errcode = '28000';
  end if;
  select * into v_item from public.ability_catalog where code = p_item_code;
  if not found then raise exception 'Unknown relic.' using errcode = '22023'; end if;

  insert into public.player_stats(user_id) values (v_user_id) on conflict (user_id) do nothing;
  select * into v_stats from public.player_stats where user_id = v_user_id for update;
  if v_stats.last_item_claimed_at is not null
     and pg_catalog.now() - v_stats.last_item_claimed_at < interval '900 milliseconds' then
    raise exception 'Relic claim is too fast. Keep flying and try the next one.' using errcode = 'P0001';
  end if;

  insert into public.player_inventory(user_id, item_code, quantity, updated_at)
  values (v_user_id, v_item.code, 1, pg_catalog.now())
  on conflict (user_id, item_code) do update
    set quantity = public.player_inventory.quantity + 1,
        updated_at = pg_catalog.now();

  update public.player_stats
  set items_collected = items_collected + 1,
      rare_items = rare_items + case when v_item.rarity in ('rare','epic','legendary','mythic') then 1 else 0 end,
      last_item_claimed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where user_id = v_user_id
  returning * into v_stats;

  select quantity into v_quantity from public.player_inventory
  where user_id = v_user_id and item_code = v_item.code;
  v_new_awards := public.unlock_skyhopper_achievements(v_user_id);

  return pg_catalog.jsonb_build_object(
    'item', pg_catalog.to_jsonb(v_item),
    'stats', pg_catalog.to_jsonb(v_stats),
    'inventory_quantity', v_quantity,
    'awards', pg_catalog.to_jsonb(v_new_awards)
  );
end;
$function$;
revoke all on function public.collect_ability_item(text) from public, anon;
grant execute on function public.collect_ability_item(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Progression RPC: buy an upgrade with earned coins
-- ---------------------------------------------------------------------------
create or replace function public.purchase_upgrade(p_upgrade_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_def public.upgrade_catalog%rowtype;
  v_stats public.player_stats%rowtype;
  v_current_level integer := 0;
  v_next_level integer;
  v_price integer;
  v_new_awards text[] := array[]::text[];
begin
  if v_user_id is null then
    raise exception 'Sign in is required to save upgrades.' using errcode = '28000';
  end if;
  select * into v_def from public.upgrade_catalog where code = p_upgrade_code;
  if not found then raise exception 'Unknown upgrade.' using errcode = '22023'; end if;

  insert into public.player_stats(user_id) values (v_user_id) on conflict (user_id) do nothing;
  select * into v_stats from public.player_stats where user_id = v_user_id for update;
  select level into v_current_level from public.player_upgrades
    where user_id = v_user_id and upgrade_code = v_def.code;
  v_current_level := coalesce(v_current_level, 0);

  if v_current_level >= v_def.max_level then
    raise exception 'This upgrade is already maxed.' using errcode = '22023';
  end if;
  v_price := least(100, v_def.base_price * (v_current_level + 1));
  if v_stats.coins < v_price then
    raise exception 'Not enough coins. Need %.', v_price using errcode = '22023';
  end if;
  v_next_level := v_current_level + 1;

  insert into public.player_upgrades(user_id, upgrade_code, level, updated_at)
  values (v_user_id, v_def.code, v_next_level, pg_catalog.now())
  on conflict (user_id, upgrade_code) do update
    set level = excluded.level, updated_at = pg_catalog.now();

  update public.player_stats
  set coins = coins - v_price,
      upgrades_purchased = upgrades_purchased + 1,
      updated_at = pg_catalog.now()
  where user_id = v_user_id
  returning * into v_stats;

  v_new_awards := public.unlock_skyhopper_achievements(v_user_id);
  return pg_catalog.jsonb_build_object(
    'stats', pg_catalog.to_jsonb(v_stats),
    'upgrade_code', v_def.code,
    'level', v_next_level,
    'price_paid', v_price,
    'awards', pg_catalog.to_jsonb(v_new_awards)
  );
end;
$function$;
revoke all on function public.purchase_upgrade(text) from public, anon;
grant execute on function public.purchase_upgrade(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Row Level Security and grants
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

alter table public.profiles enable row level security;
alter table public.player_stats enable row level security;
alter table public.user_achievements enable row level security;
alter table public.achievement_catalog enable row level security;
alter table public.ability_catalog enable row level security;
alter table public.upgrade_catalog enable row level security;
alter table public.player_inventory enable row level security;
alter table public.player_upgrades enable row level security;
alter table public.flight_runs enable row level security;

-- Reset policies on only these Sky Hopper-owned tables. This avoids a stale,
-- permissive policy from a prior setup accidentally granting broader access.
do $policies$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'profiles','player_stats','user_achievements','achievement_catalog',
        'ability_catalog','upgrade_catalog','player_inventory','player_upgrades','flight_runs'
      ])
  loop
    execute pg_catalog.format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end
$policies$;

-- Public leaderboard profile fields only; never store email/password in profiles.
create policy "Sky Hopper leaderboard profiles are public"
  on public.profiles for select to anon, authenticated using (true);
create policy "Sky Hopper players read own stats"
  on public.player_stats for select to authenticated using ((select auth.uid()) = user_id);
create policy "Sky Hopper players read own achievements"
  on public.user_achievements for select to authenticated using ((select auth.uid()) = user_id);
create policy "Sky Hopper achievement catalogue is public"
  on public.achievement_catalog for select to anon, authenticated using (true);
create policy "Sky Hopper ability catalogue is public"
  on public.ability_catalog for select to anon, authenticated using (true);
create policy "Sky Hopper upgrade catalogue is public"
  on public.upgrade_catalog for select to anon, authenticated using (true);
create policy "Sky Hopper players read own inventory"
  on public.player_inventory for select to authenticated using ((select auth.uid()) = user_id);
create policy "Sky Hopper players read own upgrades"
  on public.player_upgrades for select to authenticated using ((select auth.uid()) = user_id);
create policy "Sky Hopper players read own flight history"
  on public.flight_runs for select to authenticated using ((select auth.uid()) = user_id);

revoke all on table public.profiles, public.player_stats, public.user_achievements,
  public.achievement_catalog, public.ability_catalog, public.upgrade_catalog,
  public.player_inventory, public.player_upgrades, public.flight_runs
from anon, authenticated;

grant select on table public.profiles to anon, authenticated;
grant select on table public.achievement_catalog, public.ability_catalog, public.upgrade_catalog to anon, authenticated;
grant select on table public.player_stats, public.user_achievements,
  public.player_inventory, public.player_upgrades, public.flight_runs to authenticated;

-- All durable writes to these tables are via the SECURITY DEFINER RPCs and auth trigger.
revoke insert, update, delete, truncate, references, trigger on public.profiles from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.player_stats from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.user_achievements from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.achievement_catalog from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.ability_catalog from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.upgrade_catalog from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.player_inventory from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.player_upgrades from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.flight_runs from anon, authenticated;

-- Refuse to commit a partially seeded or internally inconsistent catalogue.
do $verify$
declare
  v_achievement_count bigint;
  v_ability_count bigint;
  v_drop_weight numeric;
begin
  select count(*) into v_achievement_count from public.achievement_catalog;
  select count(*), coalesce(sum(drop_chance_percent), 0)
    into v_ability_count, v_drop_weight from public.ability_catalog;

  if v_achievement_count <> 1000 then
    raise exception 'Sky Hopper install check failed: expected 1,000 achievements, found %.', v_achievement_count;
  end if;
  if v_ability_count <> 120 then
    raise exception 'Sky Hopper install check failed: expected 120 ability items, found %.', v_ability_count;
  end if;
  if abs(v_drop_weight - 100.0) > 0.02 then
    raise exception 'Sky Hopper install check failed: item drop weights total % instead of 100%%.', v_drop_weight;
  end if;
  if exists (select 1 from public.upgrade_catalog where base_price < 1 or base_price > 100) then
    raise exception 'Sky Hopper install check failed: an upgrade price is outside the 1–100 coin range.';
  end if;
end
$verify$;

commit;

-- ---------------------------------------------------------------------------
-- Post-install smoke tests (run separately; they are intentionally not auto-run):
-- select count(*) as achievement_count from public.achievement_catalog; -- 1000
-- select count(*) as ability_count from public.ability_catalog;         -- 120
-- select sum(drop_chance_percent) as drop_weight_sum from public.ability_catalog; -- approx 100
-- select * from public.upgrade_catalog order by base_price, code;
-- ---------------------------------------------------------------------------
