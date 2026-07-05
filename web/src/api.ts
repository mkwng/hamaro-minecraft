// API client. The custom domain is stable forever, so this never changes.
export const API = "https://api.mc.rowan.wang";

export type Status = {
  instance: string;
  server: { state: string; players: number | null; idleMinutes: number; profile: string; ts: number } | null;
  address: string;
  activeProfile: string;
};
export type OnlinePlayer = { name: string; x?: number; y?: number; z?: number; dimension?: string };
export type Warp = { x: number; y: number; z: number; dimension: string };
export type JoinRequest = { username: string; email: string; at: string };
export type BackupEntry = { key: string; size: number; lastModified: string };
export type InvItem = { slot: number; item: string; count: number };

let token = localStorage.getItem("hamaro-token") || "";
let email = localStorage.getItem("hamaro-email") || "";
let onAuthChange: (() => void) | null = null;

export const auth = {
  get token() { return token; },
  get email() { return email; },
  set(t: string, e: string) {
    token = t; email = e;
    localStorage.setItem("hamaro-token", t);
    localStorage.setItem("hamaro-email", e);
    onAuthChange?.();
  },
  clear() {
    token = ""; email = "";
    localStorage.removeItem("hamaro-token");
    localStorage.removeItem("hamaro-email");
    onAuthChange?.();
  },
  subscribe(fn: () => void) { onAuthChange = fn; },
};

export class ApiError extends Error {
  status: number;
  constructor(msg: string, status: number) { super(msg); this.status = status; }
}

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers as any) };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && !path.startsWith("/login")) auth.clear();
  if (!res.ok) throw new ApiError((data as any).error || res.statusText, res.status);
  return data as T;
}

// Poll an SSM command until it settles; reports progress via callback.
export async function watchOp(commandId: string, onUpdate: (s: string) => void): Promise<{ status: string; output?: string; error?: string }> {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const r = await api<{ status: string; output?: string; error?: string }>(`/ops/${commandId}`);
      if (r.status === "Success") return r;
      if (["Failed", "Cancelled", "TimedOut"].includes(r.status)) return r;
      onUpdate(r.status.toLowerCase());
    } catch { /* instance may be mid-restart */ }
  }
  return { status: "Unknown" };
}
