import { getSession, getUser, readSessionToken } from "../accounts/auth";
import type { Change } from "../groups/types";
import type { Env } from "../platform/env";
import { redirect } from "../platform/http";
import { esc } from "../platform/security";
import { page } from "../ui/layout";
import { matches, matchSql, ydsPreference } from "./classification";
import { loadFeed } from "../notices/handler";
import { AUDIENCES } from "../notices/types";

export async function personalHistory(db: D1Database, email: string, id = "") {
  const records = await db.prepare(`SELECT n.id,n.recorded,n.payload,CASE n.shared WHEN 1 THEN s.preference ELSE g.owner_preference END AS preference,
    json_extract(CASE n.shared WHEN 1 THEN g.published ELSE g.draft END,'$.name') AS name
    FROM skill_notices n JOIN notification_groups g ON g.id=n.group_id
    LEFT JOIN group_subscriptions s ON s.group_id=g.id AND s.email=?
    WHERE (n.shared=0 AND g.owner=? OR n.shared=1 AND s.email IS NOT NULL AND g.published IS NOT NULL)
    AND ${matchSql("CASE n.shared WHEN 1 THEN s.preference ELSE g.owner_preference END","n.payload")}
    AND (?='' OR g.id=?) ORDER BY n.recorded DESC,n.id LIMIT 500`).bind(email,email,id,id)
    .all<{id:string; recorded:number; payload:string; preference:string|null; name:string}>();
  return records.results.map(record => {
    const change: Change = JSON.parse(record.payload);
    return { ...change, id: record.id, name: record.name, recorded: record.recorded };
  });
}

export async function noticeHistory(req: Request, env: Env, id: string) {
  const email = await getSession(env.SUBS, readSessionToken(req));
  const user = email && await getUser(env.SUBS, email);
  if (!email || !user) return redirect("/");
  if (id === "yds") {
    const preference = ydsPreference(user.prefs);
    const feed = await loadFeed(env);
    const notices = feed.notices.filter(notice => (!notice.contest || !user.prefs.contests.length || user.prefs.contests.includes(notice.contest))
      && matches({ url:notice.url, summary:notice.summary, roles:notice.audiences?.length ? notice.audiences : AUDIENCES, types:[notice.category] }, preference));
    return page({title:"研电赛通知记录",heading:"研电赛通知记录",workspace:{active:"settings",email},
      body:notices.map(notice => `<article class="work-panel"><h2>${esc(notice.title)}</h2><p>${esc(notice.summary)}</p><small>${esc(notice.category)} · ${esc(notice.date)}</small> <a href="${esc(notice.url)}">查看原文</a></article>`).join("") || "<p>当前接收范围内还没有通知。</p>"});
  }
  const records = env.GROUPS ? await personalHistory(env.GROUPS,email,id) : [];
  return page({ title: "通知记录", heading: "通知记录", workspace: { active:"subscribed",email },
    body: records.map(record => `<article class="work-panel"><strong>${esc(record.name)}</strong><p>${esc(record.summary)}</p><small>${esc([...(record.roles || []), ...(record.types || [])].join(" · "))} · ${esc(new Date(record.recorded).toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai"}))}</small> <a href="${esc(record.url)}">查看原文</a></article>`).join("") || "<p>当前接收范围内还没有通知。</p>" });
}
