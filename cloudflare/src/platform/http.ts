import { securityHeaders } from "./security";

export function jsonResp(data: unknown, status = 200, cookie?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json;charset=utf-8",
    ...securityHeaders(),
  };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(JSON.stringify(data), { status, headers });
}

export function redirect(location: string, cookie?: string, status = 302): Response {
  const headers: Record<string, string> = { Location: location, ...securityHeaders() };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(null, { status, headers });
}

export function sameOrigin(req: Request): boolean {
  const site = req.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("Origin");
  // Referrer-Policy: no-referrer can make a native form POST send Origin: null.
  if (!origin || origin === "null") return site === "same-origin";
  return origin === new URL(req.url).origin;
}

export async function readForm(req: Request, maxBytes = 4096): Promise<URLSearchParams | null> {
  if (!req.body || req.headers.get("Content-Type")?.split(";")[0] !== "application/x-www-form-urlencoded") {
    return null;
  }
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return new URLSearchParams(body + decoder.decode());
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
