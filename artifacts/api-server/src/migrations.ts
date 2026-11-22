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
];
