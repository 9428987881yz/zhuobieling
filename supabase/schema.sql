create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_records (
  id uuid primary key default gen_random_uuid(),
  room_code text not null,
  game_type text not null check (game_type in ('undercover', 'gomoku', 'ludo')),
  user_id uuid references auth.users(id) on delete set null,
  player_name text not null,
  result text not null check (result in ('win', 'loss', 'draw')),
  created_at timestamptz not null default now()
);

create table if not exists public.rooms_snapshot (
  room_code text primary key,
  game_type text not null check (game_type in ('undercover', 'gomoku', 'ludo')),
  phase text not null,
  player_count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.game_records enable row level security;
alter table public.rooms_snapshot enable row level security;

drop policy if exists "Profiles are readable by everyone" on public.profiles;
create policy "Profiles are readable by everyone"
  on public.profiles for select
  using (true);

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "Users can read own records" on public.game_records;
create policy "Users can read own records"
  on public.game_records for select
  using (auth.uid() = user_id);

drop policy if exists "Room snapshots are public" on public.rooms_snapshot;
create policy "Room snapshots are public"
  on public.rooms_snapshot for select
  using (true);
