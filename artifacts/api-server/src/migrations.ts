/** Append-only. Never edit an applied migration — add a new one. */
export const MIGRATIONS: Array<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: "users, email codes, sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS vk_users (
        id bigserial PRIMARY KEY,
        email text NOT NULL UNIQUE,
        lang text NOT NULL DEFAULT 'ru',
        tz text NOT NULL DEFAULT 'UTC',
        onboarded boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_login_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS vk_email_codes (
        id bigserial PRIMARY KEY,
        email text NOT NULL,
        code_hash text NOT NULL,
        ip text,
        attempts int NOT NULL DEFAULT 0,
        used_at timestamptz,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS vk_email_codes_email ON vk_email_codes (email, created_at DESC);
      CREATE INDEX IF NOT EXISTS vk_email_codes_ip ON vk_email_codes (ip, created_at DESC);
      CREATE TABLE IF NOT EXISTS vk_sessions (
        token_hash text PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
        user_agent text,
        ip text,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vk_sessions_user ON vk_sessions (user_id);
    `,
  },
  {
    id: 2,
    name: "exchange accounts",
    sql: `
      CREATE TABLE IF NOT EXISTS vk_exchange_accounts (
        id bigserial PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
        exchange text NOT NULL,
        label text NOT NULL,
        market text NOT NULL CHECK (market IN ('spot', 'swap')),
        env text NOT NULL CHECK (env IN ('live', 'testnet')),
        credentials_enc text NOT NULL,
        key_hint text NOT NULL,
        permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
        withdraw_check text NOT NULL CHECK (withdraw_check IN ('verified_off', 'user_confirmed')),
        status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'paused')),
        last_check_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS vk_exchange_accounts_user ON vk_exchange_accounts (user_id);
    `,
  },
  {
    id: 3,
    name: "telegram link, outbox, notification settings",
    sql: `
      CREATE TABLE IF NOT EXISTS vk_telegram_links (
        user_id bigint PRIMARY KEY REFERENCES vk_users(id) ON DELETE CASCADE,
        chat_id text NOT NULL,
        username text,
        linked_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS vk_telegram_link_tokens (
        token_hash text PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vk_tg_outbox (
        id bigserial PRIMARY KEY,
        user_id bigint REFERENCES vk_users(id) ON DELETE CASCADE,
        chat_id text NOT NULL,
        kind text NOT NULL,
        text text NOT NULL,
        attempts int NOT NULL DEFAULT 0,
        next_at timestamptz NOT NULL DEFAULT now(),
        sent_at timestamptz,
        failed_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS vk_tg_outbox_due ON vk_tg_outbox (next_at) WHERE sent_at IS NULL AND failed_at IS NULL;
      CREATE TABLE IF NOT EXISTS vk_notification_settings (
        user_id bigint PRIMARY KEY REFERENCES vk_users(id) ON DELETE CASCADE,
        groups jsonb NOT NULL DEFAULT '{}'::jsonb,
        quiet_from smallint,
        quiet_to smallint
      );
      CREATE TABLE IF NOT EXISTS vk_kv (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: 4,
    name: "orders sent from the terminal",
    sql: `
      CREATE TABLE IF NOT EXISTS vk_orders (
        id bigserial PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
        account_id bigint NOT NULL REFERENCES vk_exchange_accounts(id) ON DELETE CASCADE,
        client_request_id text NOT NULL,
        source text NOT NULL DEFAULT 'terminal',
        symbol text NOT NULL,
        side text NOT NULL,
        intent text NOT NULL,
        type text NOT NULL,
        qty numeric NOT NULL,
        price numeric,
        leverage int,
        status text NOT NULL,
        exchange_order_id text,
        error_code text,
        error_message text,
        preflight jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (account_id, client_request_id)
      );
      CREATE INDEX IF NOT EXISTS vk_orders_user ON vk_orders (user_id, created_at DESC);
    `,
  },
  {
    id: 5,
    name: "managed positions and their journal",
    sql: `
      CREATE TABLE IF NOT EXISTS vk_positions (
        id bigserial PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
        account_id bigint NOT NULL REFERENCES vk_exchange_accounts(id) ON DELETE CASCADE,
        symbol text NOT NULL,
        side text NOT NULL CHECK (side IN ('long', 'short')),
        source text NOT NULL,
        source_label text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending', 'open', 'closed')),
        plan jsonb NOT NULL,
        entry_order_id text,
        entry_price numeric,
        initial_qty numeric,
        qty numeric,
        leverage int,
        stop_price numeric,
        stop_kind text,
        stop_order_id text,
        stop_where text,
        takes jsonb NOT NULL DEFAULT '[]'::jsonb,
        best_price numeric,
        be_done boolean NOT NULL DEFAULT false,
        trail_notified_at timestamptz,
        pending_close_reason text,
        realized_pnl numeric NOT NULL DEFAULT 0,
        opened_at timestamptz,
        closed_at timestamptz,
        close_reason text,
        exit_price numeric,
        pnl numeric,
        pnl_pct numeric,
        fees numeric,
        last_error text,
        last_sync_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- One managed position per account+symbol+side at a time.
      CREATE UNIQUE INDEX IF NOT EXISTS vk_positions_live ON vk_positions (account_id, symbol, side) WHERE status <> 'closed';
      CREATE INDEX IF NOT EXISTS vk_positions_user ON vk_positions (user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS vk_position_events (
        id bigserial PRIMARY KEY,
        position_id bigint NOT NULL REFERENCES vk_positions(id) ON DELETE CASCADE,
        user_id bigint NOT NULL,
        kind text NOT NULL,
        detail jsonb NOT NULL DEFAULT '{}'::jsonb,
        at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS vk_position_events_pos ON vk_position_events (position_id, id);
      CREATE INDEX IF NOT EXISTS vk_position_events_user ON vk_position_events (user_id, id DESC);
    `,
  },
  {
    id: 6,
    name: "plan edits are applied by the engine",
    sql: `ALTER TABLE vk_positions ADD COLUMN IF NOT EXISTS resync boolean NOT NULL DEFAULT false;`,
  },
  {
    id: 7,
    name: "templates, signal bots, signals, risk limits, DCA orders",
    sql: `
      CREATE TABLE IF NOT EXISTS vk_templates (
        id bigserial PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
        name text NOT NULL,
        sizing jsonb NOT NULL,
        plan jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS vk_bots (
        id bigserial PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
        account_id bigint NOT NULL REFERENCES vk_exchange_accounts(id) ON DELETE CASCADE,
        name text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        token_hint text NOT NULL,
        settings jsonb NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS vk_signals (
        id bigserial PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
        bot_id bigint NOT NULL REFERENCES vk_bots(id) ON DELETE CASCADE,
        dedup_key text NOT NULL,
        raw text NOT NULL,
        parsed jsonb,
        status text NOT NULL,
        reason text,
        detail jsonb,
        position_id bigint,
        test boolean NOT NULL DEFAULT false,
        received_at timestamptz NOT NULL DEFAULT now(),
        done_at timestamptz,
        UNIQUE (bot_id, dedup_key)
      );
      CREATE INDEX IF NOT EXISTS vk_signals_user ON vk_signals (user_id, id DESC);
      CREATE TABLE IF NOT EXISTS vk_risk (
        user_id bigint PRIMARY KEY REFERENCES vk_users(id) ON DELETE CASCADE,
        kill_switch boolean NOT NULL DEFAULT false,
        max_leverage int,
        max_margin_per_trade numeric,
        max_open_positions int,
        daily_loss_limit numeric,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE vk_positions ADD COLUMN IF NOT EXISTS dca jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    id: 8,
    name: "paper accounts",
    sql: `
      ALTER TABLE vk_exchange_accounts DROP CONSTRAINT IF EXISTS vk_exchange_accounts_env_check;
      ALTER TABLE vk_exchange_accounts ADD CONSTRAINT vk_exchange_accounts_env_check CHECK (env IN ('live', 'testnet', 'paper'));
      CREATE TABLE IF NOT EXISTS vk_paper (
        account_id bigint PRIMARY KEY REFERENCES vk_exchange_accounts(id) ON DELETE CASCADE,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: 9,
    name: "two-factor authentication",
    sql: `
      ALTER TABLE vk_users ADD COLUMN IF NOT EXISTS totp_secret_enc text;
      ALTER TABLE vk_users ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false;
      ALTER TABLE vk_users ADD COLUMN IF NOT EXISTS totp_last_step bigint;
    `,
  },
  {
    id: 10,
    name: "grid bots",
    sql: `
      CREATE TABLE IF NOT EXISTS vk_grids (
        id bigserial PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES vk_users(id) ON DELETE CASCADE,
        account_id bigint NOT NULL REFERENCES vk_exchange_accounts(id) ON DELETE CASCADE,
        name text NOT NULL,
        settings jsonb NOT NULL,
        status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'running', 'stopped', 'error')),
        state jsonb,
        stop_reason text,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        stopped_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS vk_grids_user ON vk_grids (user_id, id DESC);
    `,
  },
  {
    id: 11,
    name: "telegram channels as signal sources",
    sql: `
      CREATE TABLE IF NOT EXISTS vk_bot_channels (
        chat_id text NOT NULL,
        bot_id bigint NOT NULL REFERENCES vk_bots(id) ON DELETE CASCADE,
        title text,
        linked_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (chat_id, bot_id)
      );
      CREATE TABLE IF NOT EXISTS vk_channel_link_codes (
        code text PRIMARY KEY,
        bot_id bigint NOT NULL REFERENCES vk_bots(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL
      );
    `,
  },
];
