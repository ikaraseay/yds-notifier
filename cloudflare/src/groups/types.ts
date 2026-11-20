export type Source = {
  url: string;
  prompt: string;
  status?: "ready" | "blocked" | "error";
  detail?: string;
  sample?: string;
  baseline?: string;
  checked?: number;
};

export type GroupConfig = { name: string; sources: Source[]; enabled: boolean; templateId?: string; frequency?: "instant" | "daily" | "weekly"; guidance?: string };
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
};

export type Skill = { version: number; guidance: string; candidate?: string; evidence?: string; evaluated?: number };
export type Change = { url: string; summary: string };
