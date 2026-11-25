-- TRADING//RUST: storage on Supabase (Postgres).
--
-- HOW TO USE: paste this whole file into a SQL editor and press "Run": the "SQL Editor" in the
-- Supabase dashboard ("New query"), or the query box Vercel shows for the database. It is ONE
-- command (everything sits inside a single "do" block), so it also runs in tools that refuse a
-- script of several commands ("cannot insert multiple commands into a prepared statement").
-- It either does everything or nothing. It is safe to run again at any time: nothing is dropped
-- and no data is changed; tables are created only if they are missing, functions are replaced.
--
-- What it makes:
--   trade_accounts, trade_account_parts   one paper account per login, stored in compressed parts
--   trade_kv                              small records (logins, settings, the Stop/Reset record, locks)
--   trade_list                            append-only history (activity log, full trade ledger)
--   trade_* functions                     the only way the server reads and writes them
--   trade_users                           a view for people: every account as a row (Table Editor)
-- Every function names its tables in full ("public.") and runs with an empty search path, so it
-- cannot be made to use a look-alike table from another schema.
--
-- Who can reach it: the server only, with the project's SECRET (service role) key. Row level
-- security is switched on with no policies and the functions are closed to the public keys, so
-- nothing here can be read with the publishable (anon) key.

do $trade_setup$
declare
  v_fn record;
  v_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  v_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  v_server boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  -- ---------- Tables ----------
  create table if not exists public.trade_accounts (
    key text primary key,
    rev bigint not null default 0,                 -- goes up by one with every save
    updated_at timestamptz not null default now()
  );
  create table if not exists public.trade_account_parts (
    key text not null,
    name text not null,                            -- "main", "trades", "equity"
    hash text not null,                            -- hash of the part's JSON: a part that did not change is not sent again
    body text not null,                            -- the part's JSON, gzipped, as base64
    primary key (key, name)
  );
  create table if not exists public.trade_kv (
    key text primary key,
    value jsonb not null,                          -- {"v": <the value>}
    expires_at timestamptz                         -- null = keeps until deleted
  );
  create table if not exists public.trade_list (
    id bigint generated always as identity primary key,
    key text not null,
    value jsonb not null,
    at timestamptz not null default now()
  );
  create index if not exists trade_list_key_id on public.trade_list (key, id);

  alter table public.trade_accounts enable row level security;
  alter table public.trade_account_parts enable row level security;
  alter table public.trade_kv enable row level security;
  alter table public.trade_list enable row level security;

  -- ---------- Accounts ----------
  -- The version number of an account (null = no such account). The bot asks this every few
  -- seconds and loads the account only when the number has changed.
  create or replace function public.trade_account_rev(p_key text) returns bigint
  language sql stable set search_path = '' as $$
    select rev from public.trade_accounts where key = p_key
  $$;

  -- An account: its version and its parts. p_have = {"<part>": "<hash>"} the caller already holds;
  -- a part whose hash matches comes back without its body.
  create or replace function public.trade_account_load(p_key text, p_have jsonb) returns jsonb
  language sql stable set search_path = '' as $$
    select jsonb_build_object(
      'rev', a.rev,
      'parts', coalesce((
        select jsonb_object_agg(p.name, jsonb_build_object('h', p.hash, 'b', case when coalesce(p_have, '{}'::jsonb) ->> p.name = p.hash then null else p.body end))
        from public.trade_account_parts p where p.key = a.key
      ), '{}'::jsonb)
    )
    from public.trade_accounts a where a.key = p_key
  $$;

  -- Saves an account as a whole: after it, the stored account is exactly the parts given.
  -- p_parts = {"<part>": {"h": "<hash>", "b": "<body>" or null}}. A null body means "you already
  -- have this part with this hash"; if that is not so, nothing is saved and an error is raised
  -- (the caller then sends every body). Returns the new version number.
  create or replace function public.trade_account_save(p_key text, p_parts jsonb) returns bigint
  language plpgsql set search_path = '' as $$
  declare
    v_rev bigint;
  begin
    if p_parts is null or jsonb_typeof(p_parts) <> 'object' or not (p_parts ? 'main') then
      raise exception 'trade_account_save: no parts given';
    end if;
    -- Taking the account's row first makes two saves of one account wait for each other.
    insert into public.trade_accounts as a (key, rev, updated_at) values (p_key, 1, now())
      on conflict (key) do update set rev = a.rev + 1, updated_at = now()
      returning a.rev into v_rev;
    if exists (
      select 1 from jsonb_each(p_parts) e
      where e.value ->> 'b' is null
        and not exists (select 1 from public.trade_account_parts t where t.key = p_key and t.name = e.key and t.hash = e.value ->> 'h')
    ) then
      raise exception 'trade_account_save: part body missing';
    end if;
    insert into public.trade_account_parts as t (key, name, hash, body)
      select p_key, e.key, e.value ->> 'h', e.value ->> 'b' from jsonb_each(p_parts) e where e.value ->> 'b' is not null
      on conflict (key, name) do update set hash = excluded.hash, body = excluded.body
      where t.hash is distinct from excluded.hash;
    delete from public.trade_account_parts t where t.key = p_key and not (p_parts ? t.name);
    return v_rev;
  end $$;

  -- ---------- Small records ----------
  create or replace function public.trade_kv_get(p_key text) returns jsonb
  language sql stable set search_path = '' as $$
    select value from public.trade_kv where key = p_key and (expires_at is null or expires_at > now())
  $$;

  -- Writes a record. p_nx = only if there is none (an expired one counts as none); p_ttl_ms = it
  -- expires by itself after that long. Returns whether it wrote.
  create or replace function public.trade_kv_set(p_key text, p_value jsonb, p_nx boolean, p_ttl_ms bigint) returns boolean
  language plpgsql set search_path = '' as $$
  declare
    v_exp timestamptz := case when p_ttl_ms is null then null else clock_timestamp() + p_ttl_ms * interval '1 millisecond' end;
    v_n integer;
  begin
    if coalesce(p_nx, false) then
      insert into public.trade_kv as k (key, value, expires_at) values (p_key, p_value, v_exp)
        on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
        where k.expires_at is not null and k.expires_at <= clock_timestamp();
    else
      insert into public.trade_kv as k (key, value, expires_at) values (p_key, p_value, v_exp)
        on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at;
    end if;
    get diagnostics v_n = row_count;
    -- Records that expired long ago are swept out now and then, when one with a time limit is written.
    if p_ttl_ms is not null and random() < 0.02 then
      delete from public.trade_kv where expires_at is not null and expires_at < clock_timestamp() - interval '1 day';
    end if;
    return v_n > 0;
  end $$;

  create or replace function public.trade_kv_del(p_key text) returns boolean
  language plpgsql set search_path = '' as $$
  declare
    v_n integer;
  begin
    delete from public.trade_kv where key = p_key;
    get diagnostics v_n = row_count;
    return v_n > 0;
  end $$;

  -- ---------- Append-only lists ----------
  create or replace function public.trade_list_push(p_key text, p_value jsonb) returns bigint
  language sql set search_path = '' as $$
    insert into public.trade_list (key, value) values (p_key, p_value) returning id
  $$;

  create or replace function public.trade_list_len(p_key text) returns bigint
  language sql stable set search_path = '' as $$
    select count(*) from public.trade_list where key = p_key
  $$;

  -- Entries p_start..p_stop of a list (both included, the oldest is 0), oldest first.
  create or replace function public.trade_list_range(p_key text, p_start bigint, p_stop bigint) returns jsonb
  language sql stable set search_path = '' as $$
    select coalesce(jsonb_agg(t.value order by t.id), '[]'::jsonb)
    from (
      select id, value from public.trade_list where key = p_key
      order by id offset greatest(p_start, 0) limit greatest(p_stop - greatest(p_start, 0) + 1, 0)
    ) t
  $$;

  -- Used once, when the data is copied over from the old database: puts a batch of entries at the
  -- end of a list, in the order given (p_reset = empty the list first). Returns how many it added.
  create or replace function public.trade_list_replace(p_key text, p_items jsonb, p_reset boolean) returns bigint
  language plpgsql set search_path = '' as $$
  declare
    v_n bigint;
  begin
    if coalesce(p_reset, false) then
      delete from public.trade_list where key = p_key;
    end if;
    insert into public.trade_list (key, value)
      select p_key, e.value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as e(value, ord) order by e.ord;
    get diagnostics v_n = row_count;
    return v_n;
  end $$;

  -- ---------- Self-check ----------
  -- The server asks this when it starts: is everything here, and is it closed to the public keys?
  create or replace function public.trade_selfcheck() returns jsonb
  language sql stable set search_path = '' as $$
    select jsonb_build_object(
      'version', 1,
      'tables', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind = 'r' and c.relname in ('trade_accounts', 'trade_account_parts', 'trade_kv', 'trade_list')),
      'rls', coalesce((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind = 'r' and c.relname in ('trade_accounts', 'trade_account_parts', 'trade_kv', 'trade_list')), false),
      'open', coalesce((select bool_or(
                   has_table_privilege(r.oid, 'public.trade_accounts', 'select') or has_table_privilege(r.oid, 'public.trade_account_parts', 'select')
                   or has_table_privilege(r.oid, 'public.trade_kv', 'select') or has_table_privilege(r.oid, 'public.trade_list', 'select')
                   or has_function_privilege(r.oid, 'public.trade_kv_get(text)', 'execute'))
                 from pg_roles r where r.rolname in ('anon', 'authenticated')), false),
      'accounts', (select count(*) from public.trade_accounts)
    )
  $$;

  -- ---------- A readable list of the accounts ----------
  -- Every account the app knows is a record in trade_kv under "user:<username>", whichever way
  -- its owner signs in: with Privy (an emailed code or Google), the app keeps its own copy of
  -- the name, the email, the Privy id and the wallet address. This view shows those records as a
  -- table, for reading in Supabase's Table Editor. It holds no data of its own, leaves the
  -- password fields out, and is closed to the public keys like the tables.
  create or replace view public.trade_users with (security_invoker = true) as
    select
      k.value -> 'v' ->> 'username' as username,
      k.value -> 'v' ->> 'email' as email,
      k.value -> 'v' ->> 'firstName' as first_name,
      k.value -> 'v' ->> 'lastName' as last_name,
      case when coalesce(k.value -> 'v' ->> 'privyId', '') <> '' then 'privy' else 'password' end as signs_in_with,
      k.value -> 'v' ->> 'privyId' as privy_id,
      k.value -> 'v' ->> 'solanaAddress' as wallet,
      coalesce(k.value -> 'v' ->> 'plan', 'free') as plan,
      coalesce(k.value -> 'v' ->> 'role', 'user') as role,
      to_timestamp((k.value -> 'v' ->> 'createdAt')::numeric / 1000) as created_at
    from public.trade_kv k
    where k.key like 'user:%';

  -- ---------- Who may use it ----------
  -- Closed to everyone by default; opened to the service role (the server's secret key) only.
  -- On a plain Postgres without Supabase's roles this part does nothing beyond closing it.
  revoke all on table public.trade_accounts, public.trade_account_parts, public.trade_kv, public.trade_list from public;
  if v_anon then
    revoke all on table public.trade_accounts, public.trade_account_parts, public.trade_kv, public.trade_list from anon;
  end if;
  if v_auth then
    revoke all on table public.trade_accounts, public.trade_account_parts, public.trade_kv, public.trade_list from authenticated;
  end if;
  if v_server then
    grant all on table public.trade_accounts, public.trade_account_parts, public.trade_kv, public.trade_list to service_role;
  end if;
  revoke all on table public.trade_users from public;
  if v_anon then revoke all on table public.trade_users from anon; end if;
  if v_auth then revoke all on table public.trade_users from authenticated; end if;
  if v_server then grant select on table public.trade_users to service_role; end if;
  for v_fn in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'trade\_%'
  loop
    execute format('revoke all on function %s from public', v_fn.sig);
    if v_anon then execute format('revoke all on function %s from anon', v_fn.sig); end if;
    if v_auth then execute format('revoke all on function %s from authenticated', v_fn.sig); end if;
    if v_server then execute format('grant execute on function %s to service_role', v_fn.sig); end if;
  end loop;

  -- Tell Supabase's API layer that there are new functions to serve.
  perform pg_notify('pgrst', 'reload schema');
end
$trade_setup$;
