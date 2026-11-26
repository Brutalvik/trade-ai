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
--   trade_agent_hours                     what each account's agents made, hour by hour (linked to trade_accounts)
--   trade_wallet_tx                       every real-money transaction of every customer (buy, sell, swap, send,
--                                         receive), one row each, tagged with its customer; never deleted
--   trade_wallet_tx_events                every message about those transactions, as it came (append-only)
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
  -- What an account's agents made, hour by hour: one row per account and hour (UTC), built from
  -- the agents' closed trades. Linked to the account: it goes when the account's row goes.
  -- trade_ids = the trades already counted (counting one twice changes nothing).
  -- detail = the same figures per agent: {"<agent>": {"pnl": 12.5, "trades": 2, "wins": 1, "losses": 1, "symbols": ["ABC"]}}
  create table if not exists public.trade_agent_hours (
    key text not null references public.trade_accounts (key) on delete cascade,
    hour timestamptz not null,                     -- the start of the hour
    pnl_usd numeric not null default 0,            -- profit or loss of the trades closed in that hour, after costs
    trades integer not null default 0,             -- trades closed in that hour
    wins integer not null default 0,
    losses integer not null default 0,
    trade_ids text[] not null default '{}',
    detail jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    primary key (key, hour)
  );

  -- Every real-money transaction of every customer: buying crypto with a card or Apple Pay,
  -- selling it, swapping, sending, receiving. One table for all customers; each row is tagged with
  -- its customer (key), and the app only ever shows a customer their own rows.
  -- Written only by the server, and only from what the payment provider itself confirms (its
  -- signed messages, and the server's own questions to it), never from what a browser says.
  -- Rows are never deleted, also not when the account is: they are the record of real money.
  -- id = ours, given to the provider (MoonPay calls it "externalTransactionId"); provider_id = theirs.
  -- status: started (the customer began, nothing paid yet), pending (the provider is working on it),
  -- then one final status: completed, failed, cancelled, refunded or expired.
  -- provider_updated_at = the provider's own time for what it last told us: older news never
  -- overwrites newer. flag = something that needs a person to look (e.g. a different wallet
  -- address than the one the app gave).
  create table if not exists public.trade_wallet_tx (
    id text primary key,
    key text not null,
    provider text not null,                        -- "moonpay", ...
    provider_id text,
    kind text not null,                            -- buy, sell, swap, send, receive
    status text not null,
    provider_status text,                          -- the provider's own word for it
    final boolean not null default false,          -- no more changes expected
    fiat_currency text,
    fiat_amount numeric,                           -- what the customer paid (buy) or receives (sell), fees included
    fee_amount numeric,                            -- the provider's fee
    network_fee_amount numeric,
    extra_fee_amount numeric,                      -- the app's own fee, if any
    crypto_currency text,
    network text,
    crypto_amount numeric,
    wallet_address text,                           -- the customer's wallet it goes to (buy) or comes from (sell)
    tx_hash text,                                  -- on the blockchain
    failure_reason text,
    flag text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    provider_updated_at timestamptz,
    detail jsonb not null default '{}'::jsonb,     -- the provider's latest full record of it
    constraint trade_wallet_tx_kind check (kind in ('buy', 'sell', 'swap', 'send', 'receive')),
    constraint trade_wallet_tx_status check (status in ('started', 'pending', 'completed', 'failed', 'cancelled', 'refunded', 'expired'))
  );
  create unique index if not exists trade_wallet_tx_provider_id on public.trade_wallet_tx (provider, provider_id) where provider_id is not null;
  create index if not exists trade_wallet_tx_customer on public.trade_wallet_tx (key, created_at desc);
  create index if not exists trade_wallet_tx_open on public.trade_wallet_tx (provider, updated_at) where not final;
  -- Every message about a transaction, as it came: from the provider (webhook), from the server
  -- asking the provider (check), or from the app (app). Kept even when it changed nothing, with why.
  -- event_id = the provider's id for the message: the same message twice is kept once.
  create table if not exists public.trade_wallet_tx_events (
    id bigint generated always as identity primary key,
    tx_id text,                                    -- null when it matched no transaction
    key text,
    provider text not null,
    source text not null,                          -- webhook, check, app
    event_id text,
    event_type text,
    provider_status text,
    applied boolean not null default false,        -- did it change the transaction?
    note text,                                     -- why not, or what was odd
    payload jsonb not null default '{}'::jsonb,
    received_at timestamptz not null default now()
  );
  create unique index if not exists trade_wallet_tx_events_once on public.trade_wallet_tx_events (provider, event_id) where event_id is not null;
  create index if not exists trade_wallet_tx_events_tx on public.trade_wallet_tx_events (tx_id, id);

  alter table public.trade_accounts enable row level security;
  alter table public.trade_account_parts enable row level security;
  alter table public.trade_kv enable row level security;
  alter table public.trade_list enable row level security;
  alter table public.trade_agent_hours enable row level security;
  alter table public.trade_wallet_tx enable row level security;
  alter table public.trade_wallet_tx_events enable row level security;

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

  -- ---------- The agents' hours ----------
  -- One closed agent trade is added to its hour (and to its agent's share of that hour).
  -- Returns false when that trade was already counted.
  create or replace function public.trade_hour_add(p_key text, p_hour timestamptz, p_trade text, p_pnl numeric, p_bot text, p_symbol text) returns boolean
  language plpgsql set search_path = '' as $$
  declare
    v_hour timestamptz := date_trunc('hour', p_hour, 'UTC');
    v_win integer := (p_pnl > 0)::integer;
    v_loss integer := (p_pnl < 0)::integer;
    v_n bigint;
  begin
    insert into public.trade_agent_hours as h (key, hour, pnl_usd, trades, wins, losses, trade_ids, detail)
    values (p_key, v_hour, p_pnl, 1, v_win, v_loss, array[p_trade],
            jsonb_build_object(p_bot, jsonb_build_object('pnl', p_pnl, 'trades', 1, 'wins', v_win, 'losses', v_loss, 'symbols', jsonb_build_array(p_symbol))))
    on conflict (key, hour) do update set
      pnl_usd = h.pnl_usd + p_pnl,
      trades = h.trades + 1,
      wins = h.wins + v_win,
      losses = h.losses + v_loss,
      trade_ids = h.trade_ids || p_trade,
      detail = jsonb_set(h.detail, array[p_bot], jsonb_build_object(
        'pnl', coalesce((h.detail -> p_bot ->> 'pnl')::numeric, 0) + p_pnl,
        'trades', coalesce((h.detail -> p_bot ->> 'trades')::integer, 0) + 1,
        'wins', coalesce((h.detail -> p_bot ->> 'wins')::integer, 0) + v_win,
        'losses', coalesce((h.detail -> p_bot ->> 'losses')::integer, 0) + v_loss,
        'symbols', case when coalesce(h.detail -> p_bot -> 'symbols', '[]'::jsonb) @> to_jsonb(p_symbol)
                        then h.detail -> p_bot -> 'symbols'
                        else coalesce(h.detail -> p_bot -> 'symbols', '[]'::jsonb) || to_jsonb(p_symbol) end
      ), true),
      updated_at = now()
    where not (p_trade = any (h.trade_ids));
    get diagnostics v_n = row_count;
    return v_n > 0;
  end $$;

  -- An account's hours between two times, oldest first: [{"hour": <unix ms>, "pnl": .., "trades": .., "wins": .., "losses": .., "agents": {...}}]
  create or replace function public.trade_hours(p_key text, p_from timestamptz, p_to timestamptz) returns jsonb
  language sql stable set search_path = '' as $$
    select coalesce(jsonb_agg(jsonb_build_object(
             'hour', (extract(epoch from h.hour) * 1000)::bigint, 'pnl', h.pnl_usd, 'trades', h.trades,
             'wins', h.wins, 'losses', h.losses, 'agents', h.detail) order by h.hour), '[]'::jsonb)
    from public.trade_agent_hours h
    where h.key = p_key and h.hour >= p_from and h.hour <= p_to
  $$;

  -- ---------- Customers' wallet transactions ----------
  -- A customer starts a transaction (e.g. opens the buy screen and confirms an amount): its row,
  -- status "started". Starting the same id again changes nothing. p_fields = {"fiat_currency",
  -- "fiat_amount", "crypto_currency", "network", "crypto_amount", "wallet_address", "detail"}.
  create or replace function public.trade_wtx_start(p_id text, p_key text, p_provider text, p_kind text, p_fields jsonb) returns jsonb
  language plpgsql set search_path = '' as $$
  declare
    v_f jsonb := coalesce(p_fields, '{}'::jsonb);
    v_row public.trade_wallet_tx;
    v_n integer;
  begin
    if coalesce(p_id, '') = '' or coalesce(p_key, '') = '' or coalesce(p_provider, '') = '' then
      raise exception 'trade_wtx_start: id, customer and provider are required';
    end if;
    insert into public.trade_wallet_tx (id, key, provider, kind, status, fiat_currency, fiat_amount, crypto_currency, network, crypto_amount, wallet_address, detail)
    values (p_id, p_key, p_provider, p_kind, 'started', v_f ->> 'fiat_currency', nullif(v_f ->> 'fiat_amount', '')::numeric, v_f ->> 'crypto_currency',
            v_f ->> 'network', nullif(v_f ->> 'crypto_amount', '')::numeric, v_f ->> 'wallet_address', coalesce(v_f -> 'detail', '{}'::jsonb))
    on conflict (id) do nothing;
    get diagnostics v_n = row_count;
    select * into v_row from public.trade_wallet_tx t where t.id = p_id;
    if v_row.key <> p_key or v_row.provider <> p_provider then
      raise exception 'trade_wtx_start: that id belongs to another transaction';
    end if;
    insert into public.trade_wallet_tx_events (tx_id, key, provider, source, event_type, applied, note, payload)
    values (p_id, p_key, p_provider, 'app', 'started', v_n > 0, case when v_n > 0 then null else 'already started' end, v_f);
    return to_jsonb(v_row);
  end $$;

  -- What the provider says about a transaction (a webhook, or the server's own question to it).
  -- Found by our id (p_id) or by the provider's (p_provider_id). The message is always kept (in
  -- trade_wallet_tx_events); it changes the transaction only when it is news:
  --   - the same message twice (same p_event_id): kept once, changes nothing;
  --   - never backwards: started < pending < final; once final, only a newer final word
  --     (e.g. completed, then refunded) changes it;
  --   - at the same stage, only when the provider's own time is newer;
  --   - never across customers, never to another provider id, never when our id and the
  --     provider's id name two different transactions; a different wallet address is flagged for
  --     a person (the change still applies: it is what the provider did).
  -- A transaction the app does not know is made only when the message names its customer (p_key)
  -- and p_id and p_fields.kind are given (e.g. crypto arriving in a customer's wallet).
  -- p_fields as for trade_wtx_start, plus "fee_amount", "network_fee_amount", "extra_fee_amount",
  -- "tx_hash", "failure_reason", "kind", "flag". Returns {"applied", "duplicate", "note", "tx"}.
  create or replace function public.trade_wtx_update(p_provider text, p_id text, p_provider_id text, p_key text, p_status text, p_provider_status text,
                                                     p_provider_at timestamptz, p_fields jsonb, p_source text, p_event_id text, p_event_type text, p_payload jsonb) returns jsonb
  language plpgsql set search_path = '' as $$
  declare
    v_f jsonb := coalesce(p_fields, '{}'::jsonb);
    v_final boolean := p_status in ('completed', 'failed', 'cancelled', 'refunded', 'expired');
    v_rank integer := case p_status when 'started' then 0 when 'pending' then 1 else 2 end;
    v_old integer;
    v_event bigint;
    v_tx public.trade_wallet_tx;
    v_note text;
    v_flag text;
    v_apply boolean := false;
  begin
    if p_status is null or p_status not in ('started', 'pending', 'completed', 'failed', 'cancelled', 'refunded', 'expired') then
      raise exception 'trade_wtx_update: unknown status %', p_status;
    end if;
    -- The message first: a second copy of it stops here (also when both arrive at the same moment:
    -- the second waits for the first, then finds it).
    insert into public.trade_wallet_tx_events (key, provider, source, event_id, event_type, provider_status, payload)
    values (p_key, p_provider, coalesce(p_source, 'webhook'), p_event_id, p_event_type, p_provider_status, coalesce(p_payload, '{}'::jsonb))
    on conflict (provider, event_id) where event_id is not null do nothing
    returning id into v_event;
    if v_event is null then
      return jsonb_build_object('applied', false, 'duplicate', true, 'note', 'the same message again');
    end if;

    if p_id is not null then
      select * into v_tx from public.trade_wallet_tx t where t.id = p_id for update;
    end if;
    if v_tx.id is null and p_provider_id is not null then
      select * into v_tx from public.trade_wallet_tx t where t.provider = p_provider and t.provider_id = p_provider_id for update;
    end if;
    if v_tx.id is null and p_id is not null and p_key is not null and v_f ? 'kind' then
      insert into public.trade_wallet_tx (id, key, provider, provider_id, kind, status)
      values (p_id, p_key, p_provider, p_provider_id, v_f ->> 'kind', 'started')
      on conflict do nothing;
      select * into v_tx from public.trade_wallet_tx t where t.id = p_id for update;
      if v_tx.id is null and p_provider_id is not null then
        select * into v_tx from public.trade_wallet_tx t where t.provider = p_provider and t.provider_id = p_provider_id for update;
      end if;
    end if;

    if v_tx.id is null then
      v_note := 'no such transaction';
    elsif v_tx.provider <> p_provider then
      v_note := 'another provider''s transaction';
    elsif p_id is not null and v_tx.id <> p_id then
      v_note := 'our id and the provider''s id name different transactions';
    elsif p_key is not null and p_key <> v_tx.key then
      v_note := 'another customer''s transaction';
    elsif p_provider_id is not null and v_tx.provider_id is not null and p_provider_id <> v_tx.provider_id then
      v_note := 'another provider id';
    else
      v_old := case v_tx.status when 'started' then 0 when 'pending' then 1 else 2 end;
      if v_rank < v_old then
        v_note := 'older news: it is ' || v_tx.status || ' already';
      elsif v_rank = v_old and v_tx.provider_updated_at is not null and (p_provider_at is null or p_provider_at <= v_tx.provider_updated_at) then
        v_note := 'not newer than what is known';
      else
        v_apply := true;
      end if;
    end if;

    if v_apply then
      if v_tx.wallet_address is not null and nullif(v_f ->> 'wallet_address', '') is not null and v_f ->> 'wallet_address' <> v_tx.wallet_address then
        v_flag := 'the provider names wallet ' || (v_f ->> 'wallet_address') || ', not the one the app gave';
        v_note := v_flag;
      end if;
      update public.trade_wallet_tx t set
        status = p_status,
        provider_status = coalesce(p_provider_status, t.provider_status),
        final = v_final,
        provider_id = coalesce(t.provider_id, p_provider_id),
        fiat_currency = coalesce(nullif(v_f ->> 'fiat_currency', ''), t.fiat_currency),
        fiat_amount = coalesce(nullif(v_f ->> 'fiat_amount', '')::numeric, t.fiat_amount),
        fee_amount = coalesce(nullif(v_f ->> 'fee_amount', '')::numeric, t.fee_amount),
        network_fee_amount = coalesce(nullif(v_f ->> 'network_fee_amount', '')::numeric, t.network_fee_amount),
        extra_fee_amount = coalesce(nullif(v_f ->> 'extra_fee_amount', '')::numeric, t.extra_fee_amount),
        crypto_currency = coalesce(nullif(v_f ->> 'crypto_currency', ''), t.crypto_currency),
        network = coalesce(nullif(v_f ->> 'network', ''), t.network),
        crypto_amount = coalesce(nullif(v_f ->> 'crypto_amount', '')::numeric, t.crypto_amount),
        wallet_address = coalesce(t.wallet_address, nullif(v_f ->> 'wallet_address', '')),
        tx_hash = coalesce(nullif(v_f ->> 'tx_hash', ''), t.tx_hash),
        failure_reason = coalesce(nullif(v_f ->> 'failure_reason', ''), t.failure_reason),
        flag = coalesce(v_flag, nullif(v_f ->> 'flag', ''), t.flag),
        provider_updated_at = greatest(t.provider_updated_at, p_provider_at),
        updated_at = now(),
        detail = case when v_f ? 'detail' then v_f -> 'detail' else t.detail end
      where t.id = v_tx.id
      returning * into v_tx;
    end if;

    update public.trade_wallet_tx_events e set tx_id = v_tx.id, key = coalesce(v_tx.key, e.key), applied = v_apply, note = v_note
    where e.id = v_event;
    return jsonb_build_object('applied', v_apply, 'duplicate', false, 'note', v_note, 'tx', case when v_tx.id is null then null else to_jsonb(v_tx) end);
  end $$;

  -- A customer's transactions, newest first (p_before = only those started before then; at most 200).
  create or replace function public.trade_wtx_list(p_key text, p_before timestamptz, p_limit integer) returns jsonb
  language sql stable set search_path = '' as $$
    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc, t.id desc), '[]'::jsonb)
    from (
      select * from public.trade_wallet_tx
      where key = p_key and (p_before is null or created_at < p_before)
      order by created_at desc, id desc
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) t
  $$;

  -- One of a customer's transactions, with every message about it (oldest first). Null when it
  -- is not that customer's.
  create or replace function public.trade_wtx_get(p_key text, p_id text) returns jsonb
  language sql stable set search_path = '' as $$
    select jsonb_build_object('tx', to_jsonb(t), 'events', coalesce((
      select jsonb_agg(jsonb_build_object('at', e.received_at, 'source', e.source, 'type', e.event_type, 'status', e.provider_status, 'applied', e.applied, 'note', e.note) order by e.id)
      from public.trade_wallet_tx_events e where e.tx_id = t.id), '[]'::jsonb))
    from public.trade_wallet_tx t where t.id = p_id and t.key = p_key
  $$;

  -- Transactions of a provider that are not final yet and have not changed since p_before, oldest
  -- first: the server asks the provider about them, in case a message was lost.
  create or replace function public.trade_wtx_open(p_provider text, p_before timestamptz, p_limit integer) returns jsonb
  language sql stable set search_path = '' as $$
    select coalesce(jsonb_agg(to_jsonb(t) order by t.updated_at), '[]'::jsonb)
    from (
      select * from public.trade_wallet_tx
      where provider = p_provider and not final and updated_at < p_before
      order by updated_at
      limit least(greatest(coalesce(p_limit, 20), 1), 100)
    ) t
  $$;

  -- ---------- Self-check ----------
  -- The server asks this when it starts: is everything here, and is it closed to the public keys?
  create or replace function public.trade_selfcheck() returns jsonb
  language sql stable set search_path = '' as $$
    select jsonb_build_object(
      'version', 3,
      'hours', exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind = 'r' and c.relname = 'trade_agent_hours'),
      'wallet_tx', (select count(*) = 2 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind = 'r' and c.relname in ('trade_wallet_tx', 'trade_wallet_tx_events')),
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
  revoke all on table public.trade_agent_hours from public;
  if v_anon then revoke all on table public.trade_agent_hours from anon; end if;
  if v_auth then revoke all on table public.trade_agent_hours from authenticated; end if;
  if v_server then grant all on table public.trade_agent_hours to service_role; end if;
  revoke all on table public.trade_wallet_tx, public.trade_wallet_tx_events from public;
  if v_anon then revoke all on table public.trade_wallet_tx, public.trade_wallet_tx_events from anon; end if;
  if v_auth then revoke all on table public.trade_wallet_tx, public.trade_wallet_tx_events from authenticated; end if;
  if v_server then grant all on table public.trade_wallet_tx, public.trade_wallet_tx_events to service_role; end if;
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
