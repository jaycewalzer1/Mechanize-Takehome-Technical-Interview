-- Applied by the server on every startup (see app/db.py), so every statement
-- must be idempotent. Add new columns with ALTER TABLE ... ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT NOT NULL,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

-- Only a SHA-256 of the session token is stored; the raw token lives in the cookie.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions (user_id);

CREATE TABLE IF NOT EXISTS canvases (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    owner_id   UUID NOT NULL REFERENCES users(id),
    -- Monotonic per-canvas op sequence; bumped for every applied op (phase 3).
    seq        BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS canvas_members (
    canvas_id  UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by   UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (canvas_id, user_id)
);
CREATE INDEX IF NOT EXISTS canvas_members_user_id ON canvas_members (user_id);

-- Shapes are never row-deleted: deletion sets `deleted` (a tombstone) so late
-- updates to a deleted shape can be recognised and dropped, and undo of a
-- delete can resurrect it.
CREATE TABLE IF NOT EXISTS shapes (
    id         UUID PRIMARY KEY,  -- client-generated so creates are idempotent
    canvas_id  UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    props      JSONB NOT NULL DEFAULT '{}'::jsonb,
    deleted    BOOLEAN NOT NULL DEFAULT false,
    version    BIGINT NOT NULL DEFAULT 0,  -- canvas seq of the last change
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shapes_canvas_id ON shapes (canvas_id);

-- Edge case: V2 defense in depth. Pydantic validates every write, but the DB also
-- refuses a shape with an unknown type or a malformed color. Constraints have no
-- ADD ... IF NOT EXISTS, so the duplicate error is swallowed to stay idempotent.
DO $$ BEGIN
    ALTER TABLE shapes ADD CONSTRAINT shapes_props_valid CHECK (
        props->>'type' IN ('rect', 'ellipse', 'line', 'text')
        AND props->>'color' ~ '^#[0-9a-fA-F]{6}$'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
