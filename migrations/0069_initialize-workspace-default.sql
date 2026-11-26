-- 初回に自動作成した ID はハイフンなしの32桁、API は UUID を使う。
WITH candidates AS MATERIALIZED (
  SELECT id, row_number() OVER (
    PARTITION BY user_id ORDER BY length(id) = 32 DESC, created_at, id
  ) AS position
  FROM workspaces
  WHERE deleted_at IS NULL
), change_seq AS MATERIALIZED (
  SELECT max(
    coalesce((SELECT max(seq) FROM workspaces), 0),
    coalesce((SELECT floor FROM seq_floors WHERE table_name = 'workspaces'), 0)
  ) + 1 AS seq
)
UPDATE workspaces
SET is_default = 1, seq = (SELECT seq FROM change_seq)
WHERE id IN (SELECT id FROM candidates WHERE position = 1) AND is_default = 0;
--> statement-breakpoint
INSERT INTO workspaces (id, user_id, name, created_at, is_default, seq)
SELECT lower(hex(randomblob(16))), users.id, 'default', users.created_at, 1, (
  SELECT max(
    coalesce((SELECT max(seq) FROM workspaces), 0),
    coalesce((SELECT floor FROM seq_floors WHERE table_name = 'workspaces'), 0)
  ) + 1
)
FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM workspaces WHERE workspaces.user_id = users.id AND deleted_at IS NULL
);
--> statement-breakpoint
DROP TRIGGER users_create_default_workspace;
--> statement-breakpoint
CREATE TRIGGER users_create_default_workspace AFTER INSERT ON users BEGIN
  INSERT INTO workspaces (id, user_id, name, created_at, is_default, seq)
  VALUES (lower(hex(randomblob(16))), NEW.id, 'default', NEW.created_at, 1, (SELECT max(
    coalesce((SELECT max(seq) FROM workspaces), 0),
    coalesce((SELECT floor FROM seq_floors WHERE table_name = 'workspaces'), 0)
  ) + 1));
END;
--> statement-breakpoint
-- SQLite の一意制約を満たすため、同じ文で旧デフォルトの印を先に外す。
CREATE TRIGGER workspaces_switch_default BEFORE UPDATE OF is_default ON workspaces
WHEN OLD.is_default = 0 AND NEW.is_default = 1 AND NEW.deleted_at IS NULL
BEGIN
  UPDATE workspaces
  SET is_default = 0, seq = NEW.seq
  WHERE user_id = NEW.user_id AND is_default = 1 AND deleted_at IS NULL;
END;
