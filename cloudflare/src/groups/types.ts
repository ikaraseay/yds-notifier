export type Source = {
  url: string;
  prompt: string;
  status?: "ready" | "blocked" | "error";
  detail?: string;
  sample?: string;
  baseline?: string;
  checked?: number;
};

export type Taxonomy = { roles: string[]; types: string[] };
export type Preference = Taxonomy & { mode: "all" | "selected" | "paused" };
export type GroupConfig = { name: string; sources: Source[]; enabled: boolean; templateId?: string; frequency?: "instant" | "daily" | "weekly"; guidance?: string; taxonomy?: Taxonomy };
export type GroupRow = {
  id: string;
  owner: string;
  visibility: "private" | "pending" | "public";
  revision: number;
  draft: string;
  published: string | null;
  skill: string | null;
  next_check: number;
  review_note: string;
  owner_preference?: string;
};

export type Skill = { version: number; guidance: string; candidate?: string; evidence?: string; evaluated?: number };
export type Change = { url: string; summary: string; roles?: string[]; types?: string[]; eventDate?: string };
