import type { GroupConfig, GroupRow } from "./types";

export function parseConfig(raw: string): GroupConfig {
  return JSON.parse(raw) as GroupConfig;
}

export async function loadGroup(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM notification_groups WHERE id=?").bind(id).first<GroupRow>();
}

export async function deleteUserGroups(db: D1Database, email: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM notification_groups WHERE owner=?").bind(email),
    db.prepare("DELETE FROM group_subscriptions WHERE email=?").bind(email),
    db.prepare("DELETE FROM group_deliveries WHERE email=?").bind(email),
    db.prepare("DELETE FROM group_creators WHERE email=?").bind(email),
  ]);
}
