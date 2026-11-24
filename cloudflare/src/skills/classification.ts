import type { Change, Preference, Taxonomy } from "../groups/types";
import { AUDIENCES, CATEGORIES, type Prefs } from "../accounts/auth";

export const allNotices: Preference = { mode: "all", roles: [], types: [] };

export function ydsPreference(prefs: Prefs): Preference {
  const roles = AUDIENCES.filter(role => prefs.audiences[role.key]).map(role => role.key);
  const types: string[] = CATEGORIES.filter(category => prefs[category.key]).map(category => category.label);
  if (prefs.review) types.push("其他通知");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  if (!roles.length || !types.length || prefs.pausedUntil >= today) return {mode:"paused",roles,types};
  return { mode:"selected",roles,types };
}

export function parseLabels(value: string): string[] {
  const labels = [...new Set(value.split(/[\n,，]/).map(label => label.trim()).filter(Boolean))];
  if (labels.length > 20 || labels.some(label => label.length > 40 || /[\u0000-\u001f]/.test(label))) {
    throw new Error("每类最多 20 项，每项最多 40 字。");
  }
  return labels;
}

export function labelsIn(value: unknown, allowed: string[]): string[] {
  return allowed.filter(label => Array.isArray(value) && value.includes(label));
}

export function readPreference(form: URLSearchParams, taxonomy?: Taxonomy): Preference | null {
  const mode = form.get("mode") ?? "all";
  if (mode === "paused" || mode === "all") return { ...allNotices, mode };
  if (mode !== "selected") return null;
  const roles = labelsIn(form.getAll("roles"), taxonomy?.roles ?? []);
  const types = labelsIn(form.getAll("types"), taxonomy?.types ?? []);
  if ((!roles.length && taxonomy?.roles.length) || (!types.length && taxonomy?.types.length) || !(roles.length || types.length)) return null;
  return { mode, roles, types };
}

export function matches(change: Change, preference: Preference): boolean {
  if (preference.mode !== "selected") return preference.mode === "all";
  return (["roles", "types"] as const).every(key =>
    !preference[key].length || preference[key].some(label => change[key]?.includes(label)));
}

export function matchSql(preference: string, notice: string): string {
  const dimensions = ["roles","types"].map(key => `(json_array_length(${preference},'$.${key}')=0 OR EXISTS (
    SELECT 1 FROM json_each(${preference},'$.${key}') wanted JOIN json_each(${notice},'$.${key}') actual ON wanted.value=actual.value))`);
  return `(json_extract(${preference},'$.mode')='all' OR (json_extract(${preference},'$.mode')='selected' AND ${dimensions.join(" AND ")}))`;
}
