ALTER TABLE group_subscriptions ADD COLUMN preference TEXT NOT NULL DEFAULT '{"mode":"all","roles":[],"types":[]}';
ALTER TABLE notification_groups ADD COLUMN owner_preference TEXT NOT NULL DEFAULT '{"mode":"all","roles":[],"types":[]}';
CREATE TABLE skill_notices (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES notification_groups(id) ON DELETE CASCADE,
  shared INTEGER NOT NULL, recorded INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX skill_notices_history ON skill_notices(group_id,shared,recorded DESC);
CREATE TABLE skill_jobs (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES notification_groups(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, target TEXT NOT NULL, suggestion TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', prior TEXT NOT NULL DEFAULT '', candidate TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
);
CREATE INDEX skill_jobs_group ON skill_jobs(group_id,created DESC);
INSERT OR IGNORE INTO notification_groups(id,owner,draft) VALUES ('yds','@system',
  '{"name":"研电赛","templateId":"yds","enabled":true,"sources":[],"taxonomy":{"roles":["student","advisor","admin","organizer"],"types":["报名参赛","评审与名单","决赛与收官","赛事动态","其他通知"]}}');
