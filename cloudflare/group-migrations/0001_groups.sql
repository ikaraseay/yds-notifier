CREATE TABLE group_creators (email TEXT PRIMARY KEY, granted_at INTEGER NOT NULL);
CREATE TABLE notification_groups (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'pending', 'public')),
  draft TEXT NOT NULL,
  published TEXT,
  skill TEXT,
  next_check INTEGER NOT NULL DEFAULT 0,
  review_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX groups_owner ON notification_groups(owner);
CREATE INDEX groups_due ON notification_groups(next_check);
CREATE TABLE group_subscriptions (
  group_id TEXT NOT NULL REFERENCES notification_groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('instant', 'daily', 'weekly')),
  PRIMARY KEY (group_id, email)
);
CREATE INDEX group_subscriptions_email ON group_subscriptions(email);
CREATE TABLE group_deliveries (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES notification_groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  due INTEGER NOT NULL,
  attempt_until INTEGER NOT NULL DEFAULT 0,
  sent INTEGER,
  shared INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX group_deliveries_due ON group_deliveries(sent, due);
CREATE TABLE group_skills (
  group_id TEXT NOT NULL REFERENCES notification_groups(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  rules TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (group_id, version)
);
