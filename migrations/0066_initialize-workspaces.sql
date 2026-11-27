-- ワークスペースの初期データとトリガー。drizzle-kit generate --custom で作った枠。
INSERT INTO workspaces (id, user_id, name, created_at, seq)
SELECT lower(hex(randomblob(16))), id, 'default', created_at,
  (SELECT coalesce(max(seq), 0) + 1 FROM workspaces)
FROM users;
--> statement-breakpoint
UPDATE subscriptions
SET workspace_id = (
    SELECT id FROM workspaces
    WHERE workspaces.user_id = subscriptions.user_id AND workspaces.name = 'default'
  ),
  seq = (SELECT max(
    coalesce((SELECT max(seq) FROM subscriptions), 0),
    coalesce((SELECT floor FROM seq_floors WHERE table_name = 'subscriptions'), 0)
  ) + 1)
WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER users_create_default_workspace AFTER INSERT ON users BEGIN
  INSERT INTO workspaces (id, user_id, name, created_at, seq)
  VALUES (lower(hex(randomblob(16))), NEW.id, 'default', NEW.created_at, (SELECT max(
    coalesce((SELECT max(seq) FROM workspaces), 0),
    coalesce((SELECT floor FROM seq_floors WHERE table_name = 'workspaces'), 0)
  ) + 1));
END;
--> statement-breakpoint
CREATE TRIGGER workspaces_seq_floor AFTER DELETE ON workspaces BEGIN
  INSERT INTO seq_floors (table_name, floor) VALUES ('workspaces', OLD.seq)
    ON CONFLICT (table_name) DO UPDATE SET floor = max(floor, excluded.floor);
END;
