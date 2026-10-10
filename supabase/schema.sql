-- ============================================================================
-- SKY HOPPER: FLIGHT CLUB — COMPLETE SUPABASE DATABASE
-- ============================================================================
-- Paste this entire file into Supabase Dashboard > SQL Editor > New query and run.
--
-- Supports the current Sky Hopper Flight Club website:
--   * Supabase Auth-backed accounts and player profiles
--   * Public best-score leaderboard
--   * Player stats, XP, levels, lifetime and Arcade points, Arcade-only coins
--   * 1,000 long-haul achievement definitions and cloud unlock records
--   * 120 ability/relic definitions and 72 store cosmetics across rarity tiers
--   * Cloud inventory, upgrade catalogue, purchased upgrades, cosmetics and equipped loadouts
--   * Cloud flight history
--   * Atomic RPCs: submit_run, collect_ability_item, purchase_upgrade, purchase_store_item, equip_store_item
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
  p_score integer, p_duration_ms integer, p_mode text, p_damaged boolean, p_abilities_used integer
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_stats public.player_stats%rowtype;
  v_new_lifetime bigint;
  v_new_arcade bigint;
  v_coin_gain bigint;
  v_xp_gain bigint;
  v_new_awards text[] := array[]::text[];
begin
  if v_user_id is null then raise exception 'Sign in is required to sync a score.' using errcode = '28000'; end if;
  if p_score is null or p_score < 0 or p_score > 5000 then raise exception 'Score is outside the allowed range.' using errcode = '22023'; end if;
  if p_duration_ms is null or p_duration_ms < 1000 or p_duration_ms > 1800000 then raise exception 'Run duration is outside the allowed range.' using errcode = '22023'; end if;
  if p_score > pg_catalog.ceil(p_duration_ms::numeric / 1000)::integer + 5 then raise exception 'Score and run duration do not match.' using errcode = '22023'; end if;
  if p_mode is null or p_mode not in ('classic','arcade') then raise exception 'Unknown game mode.' using errcode = '22023'; end if;
  if p_damaged is null or p_abilities_used is null or p_abilities_used < 0 or p_abilities_used > 3 then raise exception 'Invalid run details.' using errcode = '22023'; end if;
  insert into public.profiles(id,username) values (v_user_id,'pilot_' || pg_catalog.left(pg_catalog.replace(v_user_id::text,'-',''),10)) on conflict(id) do nothing;
  insert into public.player_stats(user_id) values(v_user_id) on conflict(user_id) do nothing;
  select * into v_stats from public.player_stats where user_id=v_user_id for update;
  v_new_lifetime := v_stats.lifetime_score + p_score;
  v_new_arcade := v_stats.arcade_score + case when p_mode='arcade' then p_score else 0 end;
  v_coin_gain := case when p_mode='arcade' then pg_catalog.floor(v_new_arcade::numeric/100)::bigint - pg_catalog.floor(v_stats.arcade_score::numeric/100)::bigint else 0 end;
  v_xp_gain := greatest(10,p_score::bigint*5);
  update public.profiles set best_score=greatest(best_score,p_score), xp=xp+v_xp_gain,
    level=pg_catalog.floor(pg_catalog.sqrt((xp+v_xp_gain)::numeric/100))::integer+1, updated_at=pg_catalog.now()
    where id=v_user_id returning * into v_profile;
  update public.player_stats set games_played=games_played+1, lifetime_score=v_new_lifetime, arcade_score=v_new_arcade,
    coins=coins+v_coin_gain, updated_at=pg_catalog.now() where user_id=v_user_id returning * into v_stats;
  insert into public.flight_runs(user_id,score,mode,duration_ms,damaged,abilities_used)
    values(v_user_id,p_score,p_mode,p_duration_ms,p_damaged,p_abilities_used);
  v_new_awards := public.unlock_skyhopper_achievements(v_user_id);
  return pg_catalog.jsonb_build_object('profile',pg_catalog.to_jsonb(v_profile),'stats',pg_catalog.to_jsonb(v_stats),
    'awards',pg_catalog.to_jsonb(v_new_awards),'coins_earned',v_coin_gain,'xp_earned',v_xp_gain);
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

-- ============================================================================
-- SKY HOPPER — STORE, COSMETICS, ARCADE COINS & LONG-FLIGHT ACHIEVEMENTS PATCH
-- Run once against an existing Sky Hopper database in Supabase SQL Editor.
-- For a brand-new database, use the complete root supabase.sql master instead.
-- Idempotent table/column/catalog operations. This intentionally does not drop data.
-- ============================================================================
begin;

-- Catalogue artwork metadata belongs in Supabase; app.js contains only renderers and fallbacks.
alter table public.ability_catalog add column if not exists description text not null default '';
alter table public.ability_catalog add column if not exists aura_color text not null default '#c4cfdd';
alter table public.ability_catalog add column if not exists texture_style text not null default 'dots';
alter table public.ability_catalog add column if not exists effect_description text not null default '';

with source as (
  select a.code, a.item_type, a.rarity,
         regexp_replace(a.code, '\D', '', 'g')::integer as n,
         case a.rarity when 'common' then 0 when 'uncommon' then 1 when 'rare' then 2 when 'epic' then 3 when 'legendary' then 4 else 5 end as tier,
         case a.rarity when 'common' then regexp_replace(a.code, '\D', '', 'g')::integer - 1
           when 'uncommon' then regexp_replace(a.code, '\D', '', 'g')::integer - 41
           when 'rare' then regexp_replace(a.code, '\D', '', 'g')::integer - 71
           when 'epic' then regexp_replace(a.code, '\D', '', 'g')::integer - 93
           when 'legendary' then regexp_replace(a.code, '\D', '', 'g')::integer - 109
           else regexp_replace(a.code, '\D', '', 'g')::integer - 117 end as pos
  from public.ability_catalog a
), named as (
  select s.*,
    (array['Dawnlit','Cinder','Frostbound','Mosslight','Velvet','Astral','Tidal','Sun-forged','Moonwoven','Wildspark','Cloudglass','Rosegold','Thunderkissed','Starfall','Dreaming','Eclipse'])[(s.n * 7 + s.tier) % 16 + 1] as prefix,
    (array['Whisper','Echo','Prism','Promise','Memory','Secret','Waltz','Signal','Crown','Petal','Cipher','Lantern','Comet','Oath','Mirage'])[(s.n * 3 + s.pos) % 15 + 1] as descriptor
  from source s
)
update public.ability_catalog a
set name = n.prefix || ' ' || case n.item_type
      when 'shield' then 'Aegis' when 'slow' then 'Hourglass' when 'heal' then 'Heart' when 'magnet' then 'Magnet'
      when 'gust' then 'Gust' when 'score' then 'Star' when 'ward' then 'Ward' else 'Time Shard' end || ' ' || n.descriptor || ' ' || lpad(n.n::text,3,'0'),
    description = case n.item_type
      when 'shield' then 'Wraps the bird in a one-hit ward. The shield can rescue a risky crossing.'
      when 'slow' then 'Bends the pace of the sky, giving your next few gates a slower rhythm.'
      when 'heal' then 'Restores a heart in Arcade, or grants a brief protective pulse at full health.'
      when 'magnet' then 'Pulls nearby relics toward your flight path for a short collection window.'
      when 'gust' then 'Releases a lift of wind that nudges the bird upward and steadies its arc.'
      when 'score' then 'Charges your next gates with bonus points. Score relics never grant coins directly.'
      when 'ward' then 'A rare protective rune that refreshes a stronger shield and brief invulnerability.'
      else 'Adds time to Slow Skies and leaves a luminous time-wake behind the bird.' end,
    aura_color = case n.item_type when 'shield' then '#bca5ff' when 'slow' then '#86dfff' when 'heal' then '#ffa79c'
      when 'magnet' then '#83f1d0' when 'gust' then '#b7e6ff' when 'score' then '#ffd68a' when 'ward' then '#f2c4ff' else '#ffb8db' end,
    texture_style = case n.item_type when 'shield' then 'hex-weave' when 'slow' then 'time-rings' when 'heal' then 'heart-pulse'
      when 'magnet' then 'orbit-lines' when 'gust' then 'wind-streaks' when 'score' then 'star-map' when 'ward' then 'rune-grid' else 'prism-clock' end,
    effect_description = case n.item_type
      when 'shield' then 'Protective aura scales with relic power; can absorb a collision.'
      when 'slow' then 'Slows the world and gates for a duration scaled by relic power.'
      when 'heal' then 'Restores one heart or grants a small shield if health is full.'
      when 'magnet' then 'Expands the relic pickup radius while active.'
      when 'gust' then 'Provides an upward burst whose strength scales with relic power.'
      when 'score' then 'Adds bonus points to upcoming gate crossings; does not award coins directly.'
      when 'ward' then 'Creates a reinforced protective aura and short invulnerability.'
      else 'Extends the Slow Skies effect and adds a time-shard aura.' end
from named n where a.code = n.code;

-- 1,000 challenging achievements: later milestones become long-haul goals.
update public.achievement_catalog a set target = case
  when a.code like 'score_%' then (select case when n <= 20 then n when n <= 50 then 20 + (n-20)*5 when n <= 100 then 170 + (n-50)*10 when n <= 150 then 670 + (n-100)*25 else 1920 + (n-150)*59 end from (select regexp_replace(a.code,'\D','','g')::integer n) q)
  when a.code like 'flights_%' then (select case when n <= 25 then n when n <= 100 then 25 + (n-25)*4 when n <= 150 then 325 + (n-100)*10 else 825 + (n-150)*1500 + (n-150)*(n-150)*130 end from (select regexp_replace(a.code,'\D','','g')::integer n) q)
  when a.code like 'items_%' then (select case when n <= 25 then n when n <= 75 then 25 + (n-25)*5 when n <= 125 then 275 + (n-75)*20 else 1275 + (n-125)*550 + (n-125)*(n-125)*80 end from (select regexp_replace(a.code,'\D','','g')::integer n) q)
  when a.code like 'rare_%' then (select case when n <= 10 then n when n <= 40 then 10 + (n-10)*3 when n <= 100 then 100 + (n-40)*10 else 700 + (n-100)*1500 + (n-100)*(n-100)*200 end from (select regexp_replace(a.code,'\D','','g')::integer n) q)
  when a.code like 'arcade_%' then (select case when n <= 25 then n when n <= 75 then 25 + (n-25)*5 when n <= 125 then 275 + (n-75)*20 else 1275 + (n-125)*2500 + (n-125)*(n-125)*200 end from (select regexp_replace(a.code,'\D','','g')::integer n) q)
  when a.code like 'upgrades_%' then (select case when n <= 10 then n when n <= 30 then 10 + (n-10)*2 when n <= 60 then 50 + (n-30) else 80 + ceil((n-60)*23.0/40)::integer end from (select regexp_replace(a.code,'\D','','g')::integer n) q)
  else a.target end;

update public.achievement_catalog a set description = case
  when a.code like 'score_%' then 'Reach a best score of ' || a.target::text || '.'
  when a.code like 'flights_%' then 'Complete ' || a.target::text || ' flights.'
  when a.code like 'items_%' then 'Collect ' || a.target::text || ' flight relics.'
  when a.code like 'rare_%' then 'Collect ' || a.target::text || ' rare-or-better relics.'
  when a.code like 'arcade_%' then 'Earn ' || a.target::text || ' total Arcade points.'
  when a.code like 'upgrades_%' then 'Complete ' || a.target::text || ' in-game store purchases.'
  else a.description end;

create table if not exists public.store_catalog (
  code text primary key,
  name text not null,
  slot text not null check (slot in ('bird','aura','trail','wings')),
  description text not null,
  rarity text not null check (rarity in ('common','uncommon','rare','epic','legendary','mythic')),
  price integer not null default 25 check (price between 0 and 100),
  primary_color text not null,
  secondary_color text not null,
  texture_style text not null,
  symbol text not null,
  created_at timestamptz not null default pg_catalog.now()
);

insert into public.store_catalog(code,name,slot,description,rarity,price,primary_color,secondary_color,texture_style,symbol)
values
  ('bird_classic', 'Classic Dawn', 'bird', 'The original little flyer, touched by a warm sunrise.', 'common', 0, '#ffd477', '#f49a5e', 'dots', '✦'),
  ('bird_cobalt', 'Cobalt Current', 'bird', 'Deep-blue feathers with a cool current running through them.', 'common', 25, '#86dfff', '#4567ca', 'waves', '◈'),
  ('bird_peach', 'Peach Comet', 'bird', 'Soft peach enamel with comet-dust speckles.', 'common', 25, '#ffbca0', '#e77b83', 'speckles', '✧'),
  ('bird_moss', 'Mosslight Sprite', 'bird', 'A woodland glow with leaf-like feather markings.', 'common', 30, '#9bdaa2', '#447d63', 'leaf', '❋'),
  ('bird_lilac', 'Lilac Dream', 'bird', 'Lilac plumage that catches the light like a lucid dream.', 'uncommon', 35, '#d4b7ff', '#8875d5', 'stars', '✦'),
  ('bird_ember', 'Emberwing', 'bird', 'Burnished ember feathers and a little extra attitude.', 'uncommon', 40, '#ff9b72', '#c94d54', 'flame', '♨'),
  ('bird_glacier', 'Glacier Finch', 'bird', 'Ice-blue feathers with a crystalline frost pattern.', 'uncommon', 40, '#c7f4ff', '#76b9d9', 'frost', '❄'),
  ('bird_honey', 'Honey Halo', 'bird', 'Golden honey tones and a glossy, sunlit belly.', 'uncommon', 45, '#ffe49a', '#cf8b36', 'honeycomb', '✺'),
  ('bird_rose', 'Rose Quartz', 'bird', 'Polished rose-quartz colours with delicate crystal facets.', 'rare', 50, '#ffb6d4', '#b65f93', 'crystal', '♡'),
  ('bird_midnight', 'Midnight Owl', 'bird', 'A night-sky coat sprinkled with tiny constellations.', 'rare', 55, '#68729e', '#222b52', 'constellation', '☾'),
  ('bird_solar', 'Solar Flare', 'bird', 'Bright solar gold with a fiery orange edge.', 'rare', 60, '#fff0a8', '#ff804b', 'rays', '☼'),
  ('bird_jade', 'Jade Lantern', 'bird', 'Jade enamel with small, overlapping scale marks.', 'rare', 60, '#85e4ca', '#237e75', 'scales', '◈'),
  ('bird_aurora', 'Aurora Echo', 'bird', 'A shifting aurora gradient across the original bird silhouette.', 'epic', 70, '#b4f5e8', '#a9a0ff', 'aurora', '✧'),
  ('bird_prism', 'Prism Drift', 'bird', 'Prismatic feather highlights that shimmer when you flap.', 'epic', 75, '#ffb4df', '#8bd9ff', 'prism', '◇'),
  ('bird_starforged', 'Starforged', 'bird', 'Forged in a comet trail, engraved with star-map lines.', 'legendary', 90, '#ffe3a3', '#8e7be8', 'star-map', '✦'),
  ('bird_eclipse', 'Eclipse Sovereign', 'bird', 'A velvet-dark body framed by a luminous eclipse rim.', 'mythic', 100, '#f3c7ff', '#33395f', 'eclipse', '◉'),
  ('bird_tangerine', 'Tangerine Twist', 'bird', 'A citrus colourway with fast, angled feather marks.', 'uncommon', 35, '#ffc57a', '#f16a4d', 'stripes', '➶'),
  ('bird_seaglass', 'Sea Glass', 'bird', 'Sea-glass colour and tiny bubbles from an imagined coast.', 'epic', 80, '#c2fff0', '#479aaf', 'bubbles', '◌'),
  ('aura_none', 'Barely a Breeze', 'aura', 'No aura at all: keep the unadorned classic look.', 'common', 0, '#8090ad', '#52617c', 'none', '·'),
  ('aura_mint', 'Mint Orbit', 'aura', 'A clean mint orbit that loops around your bird.', 'common', 25, '#83f1d0', '#b9ffed', 'orbit', '◌'),
  ('aura_sun', 'Sun Halo', 'aura', 'A small golden solar halo with pulsing rays.', 'common', 25, '#ffd68a', '#fff2c1', 'sunrays', '☼'),
  ('aura_violet', 'Violet Crown', 'aura', 'Violet arcs rotate like a tiny crown.', 'common', 30, '#bca5ff', '#f1dcff', 'crown', '♛'),
  ('aura_ember', 'Ember Ring', 'aura', 'Warm embers orbit your bird in slow spirals.', 'uncommon', 35, '#ff9b72', '#ffd18c', 'embers', '✧'),
  ('aura_moon', 'Moon Mist', 'aura', 'A cool lunar haze with crescent sparks.', 'uncommon', 40, '#d7e4ff', '#8ba6d8', 'moon', '☾'),
  ('aura_ocean', 'Ocean Pulse', 'aura', 'Three ocean-blue pulses ripple out from your flight.', 'uncommon', 40, '#86dfff', '#397bb7', 'ripple', '◎'),
  ('aura_rose', 'Rose Nebula', 'aura', 'A rose-and-lilac nebula swirls around the silhouette.', 'rare', 50, '#ffa9ce', '#bc82e4', 'nebula', '✿'),
  ('aura_aurora', 'Aurora Veil', 'aura', 'A soft, shifting northern-light veil.', 'rare', 55, '#83f1d0', '#bca5ff', 'aurora', '⌁'),
  ('aura_starfield', 'Starfield Halo', 'aura', 'A halo of little stars that orbit at different speeds.', 'rare', 60, '#d5ddff', '#7f8dff', 'stars', '✦'),
  ('aura_prism', 'Prism Halo', 'aura', 'Prismatic double rings flash subtly as you flap.', 'epic', 70, '#ffb4df', '#86dfff', 'prism', '◇'),
  ('aura_thunder', 'Thunder Arc', 'aura', 'A restrained electric arc flickers between two points.', 'epic', 75, '#a9c5ff', '#7e72db', 'lightning', 'ϟ'),
  ('aura_frost', 'Frost Sigil', 'aura', 'A faint crystalline sigil made of icy motes.', 'epic', 75, '#d5fbff', '#8bcde8', 'snowflake', '❄'),
  ('aura_golden', 'Golden Hour', 'aura', 'Warm gold light with a soft cinematic flare.', 'legendary', 90, '#ffdb83', '#e99b47', 'sunrays', '✺'),
  ('aura_eclipse', 'Mythic Eclipse', 'aura', 'Dark-violet eclipse rings with a bright pearl corona.', 'legendary', 95, '#f4ceff', '#7d77f8', 'eclipse', '◉'),
  ('aura_celestial', 'Celestial Choir', 'aura', 'A rare constellation draws itself around the bird.', 'mythic', 100, '#fbe8ae', '#bbadff', 'constellation', '✧'),
  ('aura_coral', 'Coral Bloom', 'aura', 'Tiny coral petals blossom and drift away.', 'uncommon', 35, '#ffb5a7', '#f28f9f', 'petals', '❀'),
  ('aura_glacier', 'Glacier Crown', 'aura', 'An icy crown glitters with a cool blue aura.', 'epic', 80, '#c8f5ff', '#7197db', 'frost', '✧'),
  ('trail_none', 'Quiet Air', 'trail', 'No wake behind you, just the pure bird and the gaps.', 'common', 0, '#8090ad', '#52617c', 'none', '·'),
  ('trail_mint', 'Mint Ribbon', 'trail', 'A thin mint ribbon follows every flap.', 'common', 25, '#83f1d0', '#c0ffee', 'ribbon', '〰'),
  ('trail_comet', 'Comet Dust', 'trail', 'A fine trail of star dust that fades quickly.', 'common', 25, '#ffd68a', '#fff4ce', 'dust', '✦'),
  ('trail_bubble', 'Bubble Drift', 'trail', 'Little transparent bubbles float in your wake.', 'common', 30, '#86dfff', '#c9f5ff', 'bubbles', '◌'),
  ('trail_rose', 'Rosewave', 'trail', 'A pink wave that undulates with your bird.', 'uncommon', 35, '#ffa9ce', '#ffd5e9', 'wave', '〰'),
  ('trail_ember', 'Ember Dash', 'trail', 'Bright embers flicker and dim behind each flap.', 'uncommon', 40, '#ff9b72', '#ffd18c', 'embers', '✧'),
  ('trail_violet', 'Violet Afterimage', 'trail', 'Two faint afterimages trail the bird.', 'uncommon', 40, '#bca5ff', '#e8dbff', 'echo', '◇'),
  ('trail_ocean', 'Ocean Wake', 'trail', 'A sea-blue wake like sunlight on water.', 'rare', 50, '#67cce9', '#b2f3ff', 'wave', '≈'),
  ('trail_leaves', 'Autumn Leaves', 'trail', 'Tiny warm leaves tumble in the draft.', 'rare', 55, '#edac70', '#f8d5a6', 'leaves', '❧'),
  ('trail_snow', 'Snowfall Line', 'trail', 'A drifting snowfall that only lasts a heartbeat.', 'rare', 60, '#e5f4ff', '#aacfe9', 'snow', '❄'),
  ('trail_prism', 'Prism Stream', 'trail', 'A quiet pastel spectrum with no harsh flashing.', 'epic', 70, '#ffaee5', '#8bdfff', 'prism', '◇'),
  ('trail_lightning', 'Lightning Stitch', 'trail', 'Short electric stitches punctuate the trail.', 'epic', 75, '#a9c5ff', '#e2d8ff', 'lightning', 'ϟ'),
  ('trail_starlight', 'Starlight Wake', 'trail', 'Tiny distant stars appear then wink out.', 'epic', 80, '#fff0b7', '#c4c7ff', 'stars', '✦'),
  ('trail_phoenix', 'Phoenix Ribbon', 'trail', 'A fiery ribbon with a glowing core.', 'legendary', 90, '#ffb270', '#ff6f81', 'flame', '♨'),
  ('trail_void', 'Void Thread', 'trail', 'A dark thread edged by a soft spectral line.', 'legendary', 95, '#c1b6ff', '#6169aa', 'void', '◈'),
  ('trail_celestial', 'Celestial River', 'trail', 'A tiny celestial river that leaves star-map sparks.', 'mythic', 100, '#dbf7ff', '#d6b4ff', 'constellation', '✧'),
  ('trail_pollen', 'Spring Pollen', 'trail', 'Spring petals wander gently from the flight path.', 'uncommon', 35, '#ffe0ef', '#c4efbb', 'petals', '❀'),
  ('trail_tidal', 'Tidal Glass', 'trail', 'Glassy aqua drops shimmer in a smooth, flowing trail.', 'epic', 80, '#9cebe0', '#518cc0', 'bubbles', '◌'),
  ('wings_classic', 'Classic Feathers', 'wings', 'The original wing and its familiar two-beat flap.', 'common', 0, '#f7dfac', '#d99057', 'classic', '⌁'),
  ('wings_sail', 'Sailcloth Wings', 'wings', 'A soft sailcloth wing with a crisp outlined edge.', 'common', 25, '#f2f0e5', '#8ba9b8', 'sail', '⌁'),
  ('wings_ember', 'Ember Tips', 'wings', 'Warm ember tips appear at the end of each flap.', 'common', 25, '#ffcb93', '#e56b52', 'flame', '♨'),
  ('wings_frost', 'Frost Feathers', 'wings', 'Icy feather panels with subtle bright tips.', 'common', 30, '#d5f6ff', '#78b5de', 'frost', '❄'),
  ('wings_royal', 'Royal Pinions', 'wings', 'Royal violet panels with small gold accents.', 'uncommon', 35, '#d3b9ff', '#7a63be', 'royal', '♛'),
  ('wings_mint', 'Mint Gliders', 'wings', 'Sleek glider-style wings with mint leading edges.', 'uncommon', 40, '#a9f8db', '#4aaf99', 'glider', '➶'),
  ('wings_rose', 'Rose Petals', 'wings', 'Petal-shaped panels that fan during the flap cycle.', 'uncommon', 40, '#ffc4df', '#c46a98', 'petal', '❀'),
  ('wings_aurora', 'Aurora Pinions', 'wings', 'A shifting green-violet sheen on the wing panels.', 'rare', 50, '#c5ffe9', '#9b8be6', 'aurora', '✧'),
  ('wings_moon', 'Moon-feather', 'wings', 'Pale lunar feathers with crescent etching.', 'rare', 55, '#dfe6ff', '#8a98cb', 'moon', '☾'),
  ('wings_solar', 'Solar Kite', 'wings', 'Golden sail wings warmed by a solar edge.', 'rare', 60, '#ffeaa7', '#e9a54a', 'solar', '☼'),
  ('wings_jade', 'Jade Sculpted', 'wings', 'Layered jade scales form a sculpted wing.', 'rare', 60, '#a9e8cf', '#398a75', 'scales', '◈'),
  ('wings_prism', 'Prism Plumes', 'wings', 'Prismatic feather panels with softly shifting colour.', 'epic', 70, '#ffd0ef', '#80dff7', 'prism', '◇'),
  ('wings_storm', 'Storm Runners', 'wings', 'Angular wing tips with a muted electric glow.', 'epic', 75, '#bac8ff', '#6578bc', 'storm', 'ϟ'),
  ('wings_starforged', 'Starforged Wings', 'wings', 'Star-map etching across legendary golden wings.', 'legendary', 90, '#ffe0a5', '#9681e4', 'star-map', '✦'),
  ('wings_phoenix', 'Phoenix Plumes', 'wings', 'A bright phoenix colourway that keeps the original shape.', 'legendary', 95, '#ffbd79', '#dc5471', 'flame', '♨'),
  ('wings_eclipse', 'Eclipse Crownwings', 'wings', 'A dark celestial panel edged in a thin pearl glow.', 'mythic', 100, '#edddff', '#555787', 'eclipse', '◉'),
  ('wings_meadow', 'Meadow Glide', 'wings', 'Meadow-green panels with leaf-shaped feathers.', 'uncommon', 35, '#d6f4a8', '#65b88b', 'leaf', '❋'),
  ('wings_tide', 'Tidal Kites', 'wings', 'Tidal blue wings with wave-like inlay.', 'epic', 80, '#a5e7ff', '#427dac', 'wave', '≈')
on conflict (code) do update set name=excluded.name, slot=excluded.slot, description=excluded.description,
  rarity=excluded.rarity, price=excluded.price, primary_color=excluded.primary_color,
  secondary_color=excluded.secondary_color, texture_style=excluded.texture_style, symbol=excluded.symbol;

create table if not exists public.player_cosmetics (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_code text not null references public.store_catalog(code) on delete restrict,
  purchased_at timestamptz not null default pg_catalog.now(),
  primary key (user_id,item_code)
);
create table if not exists public.player_loadout (
  user_id uuid primary key references auth.users(id) on delete cascade,
  bird_code text not null default 'bird_classic' references public.store_catalog(code) on delete restrict,
  aura_code text not null default 'aura_none' references public.store_catalog(code) on delete restrict,
  trail_code text not null default 'trail_none' references public.store_catalog(code) on delete restrict,
  wings_code text not null default 'wings_classic' references public.store_catalog(code) on delete restrict,
  updated_at timestamptz not null default pg_catalog.now()
);

-- Revised reward math: only Arcade score pays coins at 0.01 coin per point.
create or replace function public.submit_run(
  p_score integer, p_duration_ms integer, p_mode text, p_damaged boolean, p_abilities_used integer
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_stats public.player_stats%rowtype;
  v_new_lifetime bigint;
  v_new_arcade bigint;
  v_coin_gain bigint;
  v_xp_gain bigint;
  v_new_awards text[] := array[]::text[];
begin
  if v_user_id is null then raise exception 'Sign in is required to sync a score.' using errcode = '28000'; end if;
  if p_score is null or p_score < 0 or p_score > 5000 then raise exception 'Score is outside the allowed range.' using errcode = '22023'; end if;
  if p_duration_ms is null or p_duration_ms < 1000 or p_duration_ms > 1800000 then raise exception 'Run duration is outside the allowed range.' using errcode = '22023'; end if;
  if p_score > pg_catalog.ceil(p_duration_ms::numeric / 1000)::integer + 5 then raise exception 'Score and run duration do not match.' using errcode = '22023'; end if;
  if p_mode is null or p_mode not in ('classic','arcade') then raise exception 'Unknown game mode.' using errcode = '22023'; end if;
  if p_damaged is null or p_abilities_used is null or p_abilities_used < 0 or p_abilities_used > 3 then raise exception 'Invalid run details.' using errcode = '22023'; end if;
  insert into public.profiles(id,username) values (v_user_id,'pilot_' || pg_catalog.left(pg_catalog.replace(v_user_id::text,'-',''),10)) on conflict(id) do nothing;
  insert into public.player_stats(user_id) values(v_user_id) on conflict(user_id) do nothing;
  select * into v_stats from public.player_stats where user_id=v_user_id for update;
  v_new_lifetime := v_stats.lifetime_score + p_score;
  v_new_arcade := v_stats.arcade_score + case when p_mode='arcade' then p_score else 0 end;
  v_coin_gain := case when p_mode='arcade' then pg_catalog.floor(v_new_arcade::numeric/100)::bigint - pg_catalog.floor(v_stats.arcade_score::numeric/100)::bigint else 0 end;
  v_xp_gain := greatest(10,p_score::bigint*5);
  update public.profiles set best_score=greatest(best_score,p_score), xp=xp+v_xp_gain,
    level=pg_catalog.floor(pg_catalog.sqrt((xp+v_xp_gain)::numeric/100))::integer+1, updated_at=pg_catalog.now()
    where id=v_user_id returning * into v_profile;
  update public.player_stats set games_played=games_played+1, lifetime_score=v_new_lifetime, arcade_score=v_new_arcade,
    coins=coins+v_coin_gain, updated_at=pg_catalog.now() where user_id=v_user_id returning * into v_stats;
  insert into public.flight_runs(user_id,score,mode,duration_ms,damaged,abilities_used)
    values(v_user_id,p_score,p_mode,p_duration_ms,p_damaged,p_abilities_used);
  v_new_awards := public.unlock_skyhopper_achievements(v_user_id);
  return pg_catalog.jsonb_build_object('profile',pg_catalog.to_jsonb(v_profile),'stats',pg_catalog.to_jsonb(v_stats),
    'awards',pg_catalog.to_jsonb(v_new_awards),'coins_earned',v_coin_gain,'xp_earned',v_xp_gain);
end;
$function$;
revoke all on function public.submit_run(integer,integer,text,boolean,integer) from public,anon;
grant execute on function public.submit_run(integer,integer,text,boolean,integer) to authenticated;

create or replace function public.purchase_store_item(p_item_code text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_user_id uuid := auth.uid(); v_item public.store_catalog%rowtype; v_stats public.player_stats%rowtype; v_awards text[] := array[]::text[];
begin
  if v_user_id is null then raise exception 'Sign in is required to buy store items.' using errcode='28000'; end if;
  select * into v_item from public.store_catalog where code=p_item_code;
  if not found then raise exception 'Unknown store item.' using errcode='22023'; end if;
  insert into public.player_stats(user_id) values(v_user_id) on conflict(user_id) do nothing;
  select * into v_stats from public.player_stats where user_id=v_user_id for update;
  if exists(select 1 from public.player_cosmetics where user_id=v_user_id and item_code=v_item.code) then raise exception 'You already own this item.' using errcode='22023'; end if;
  if v_stats.coins < v_item.price then raise exception 'Not enough coins. Need %.',v_item.price using errcode='22023'; end if;
  insert into public.player_cosmetics(user_id,item_code) values(v_user_id,v_item.code);
  update public.player_stats set coins=coins-v_item.price, upgrades_purchased=upgrades_purchased+1, updated_at=pg_catalog.now()
    where user_id=v_user_id returning * into v_stats;
  v_awards := public.unlock_skyhopper_achievements(v_user_id);
  return pg_catalog.jsonb_build_object('item',pg_catalog.to_jsonb(v_item),'stats',pg_catalog.to_jsonb(v_stats),'awards',pg_catalog.to_jsonb(v_awards));
end;
$function$;
revoke all on function public.purchase_store_item(text) from public,anon;
grant execute on function public.purchase_store_item(text) to authenticated;

create or replace function public.equip_store_item(p_item_code text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_user_id uuid := auth.uid(); v_item public.store_catalog%rowtype; v_loadout public.player_loadout%rowtype;
begin
  if v_user_id is null then raise exception 'Sign in is required to equip cosmetics.' using errcode='28000'; end if;
  select * into v_item from public.store_catalog where code=p_item_code;
  if not found then raise exception 'Unknown store item.' using errcode='22023'; end if;
  if v_item.price > 0 and not exists(select 1 from public.player_cosmetics where user_id=v_user_id and item_code=v_item.code) then
    raise exception 'You must buy this item before equipping it.' using errcode='22023';
  end if;
  if v_item.price = 0 then insert into public.player_cosmetics(user_id,item_code) values(v_user_id,v_item.code) on conflict(user_id,item_code) do nothing; end if;
  insert into public.player_loadout(user_id) values(v_user_id) on conflict(user_id) do nothing;
  update public.player_loadout set
    bird_code=case when v_item.slot='bird' then v_item.code else bird_code end,
    aura_code=case when v_item.slot='aura' then v_item.code else aura_code end,
    trail_code=case when v_item.slot='trail' then v_item.code else trail_code end,
    wings_code=case when v_item.slot='wings' then v_item.code else wings_code end,
    updated_at=pg_catalog.now()
  where user_id=v_user_id returning * into v_loadout;
  return pg_catalog.to_jsonb(v_loadout);
end;
$function$;
revoke all on function public.equip_store_item(text) from public,anon;
grant execute on function public.equip_store_item(text) to authenticated;

-- Read-only public catalogues; private player rows are selectable only by their owner.
alter table public.store_catalog enable row level security;
alter table public.player_cosmetics enable row level security;
alter table public.player_loadout enable row level security;
drop policy if exists "Sky Hopper public store catalogue" on public.store_catalog;
drop policy if exists "Sky Hopper read own cosmetics" on public.player_cosmetics;
drop policy if exists "Sky Hopper read own loadout" on public.player_loadout;
create policy "Sky Hopper public store catalogue" on public.store_catalog for select to anon,authenticated using (true);
create policy "Sky Hopper read own cosmetics" on public.player_cosmetics for select to authenticated using ((select auth.uid())=user_id);
create policy "Sky Hopper read own loadout" on public.player_loadout for select to authenticated using ((select auth.uid())=user_id);
revoke all on table public.store_catalog,public.player_cosmetics,public.player_loadout from anon,authenticated;
grant select on table public.store_catalog to anon,authenticated;
grant select on table public.player_cosmetics,public.player_loadout to authenticated;
revoke insert,update,delete,truncate,references,trigger on public.store_catalog,public.player_cosmetics,public.player_loadout from anon,authenticated;

-- A concise verification result for the SQL Editor.
do $verify$
declare v_achievement_count bigint; v_relic_count bigint; v_store_count bigint; v_bad_prices bigint; v_bad_defaults bigint;
begin
  select count(*) into v_achievement_count from public.achievement_catalog;
  select count(*) into v_relic_count from public.ability_catalog;
  select count(*) into v_store_count from public.store_catalog;
  select count(*) into v_bad_prices from public.store_catalog where price < 0 or price > 100;
  select count(*) into v_bad_defaults from public.store_catalog where code in ('bird_classic','aura_none','trail_none','wings_classic') and price <> 0;
  if v_achievement_count<>1000 then raise exception 'Expected 1,000 achievements, found %',v_achievement_count; end if;
  if v_relic_count<>120 then raise exception 'Expected 120 relics, found %',v_relic_count; end if;
  if v_store_count<>72 then raise exception 'Expected 72 store cosmetics, found %',v_store_count; end if;
  if v_bad_prices<>0 or v_bad_defaults<>0 then raise exception 'Store price/default validation failed'; end if;
end;
$verify$;
commit;
