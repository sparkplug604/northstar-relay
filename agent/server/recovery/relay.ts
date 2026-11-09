import { readAppSecret } from "@agent-native/core/secrets";

export const relayOrigin = "http://127.0.0.1:3004";
const base = relayOrigin + "/api/relay/v1";
type Session = { cookie: string; csrfToken: string };
// Share one scoped synthetic session across native actions and retained engines on HMR.
const authGlobal=globalThis as typeof globalThis&{__relaySyntheticAuthV1?:{pending?:Promise<Session>;blockedUntil?:number}};
const authState=authGlobal.__relaySyntheticAuthV1??={};

async function signIn(): Promise<Session> {
  if((authState.blockedUntil??0)>Date.now())throw new Error('Relay sign-in is temporarily rate-limited. Wait a minute, then reload Ask Relay.');
  const secret = await readAppSecret({
    key: "RELAY_SYNTHETIC_DISPATCHER", scope: "workspace", scopeId: "relay-recovery-local",
  });
  if (!secret) throw new Error("Provision the synthetic Relay dispatcher in the local vault.");
  const response = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { origin: relayOrigin, "content-type": "application/json" },
    body: JSON.stringify({ email: "dispatch@relay-demo.invalid", password: secret.value }),
  });
  if(response.status===429){authState.blockedUntil=Date.now()+60000;throw new Error('Relay sign-in is temporarily rate-limited. Wait a minute, then reload Ask Relay.');}
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!response.ok || !cookie) throw new Error(`Synthetic Relay login failed (${response.status}).`);
  const result = await response.json();
  if (result.mfaRequired || !result.csrfToken) throw new Error("Expected the synthetic dispatcher session.");
  return { cookie, csrfToken: result.csrfToken };
}

export class RelayRequestError extends Error {constructor(public status:number){super(`Relay rejected the request (${status}). Reload the job and retry.`);}}

export async function relay<T>(path: string, change?: { body: object; key: string }, retry = true): Promise<T> {
  const pending = authState.pending ??= signIn();
  let auth: Session;
  try {
    auth = await pending;
  } catch (error) {
    if (authState.pending === pending) delete authState.pending;
    throw error;
  }
  const response = await fetch(base + path, {
    method: change ? "POST" : "GET",
    signal: AbortSignal.timeout(path.includes('/assignment')?45000:10000),
    headers: { origin: relayOrigin, cookie: auth.cookie, ...(change && {
      "content-type": "application/json", "x-csrf-token": auth.csrfToken, "idempotency-key": change.key,
    }) },
    ...(change && { body: JSON.stringify(change.body) }),
  });
  if (response.status === 401 && retry) {
    if (authState.pending === pending) delete authState.pending;
    return relay(path, change, false);
  }
  if (!response.ok) throw new RelayRequestError(response.status);
  return response.json() as Promise<T>;
}

export type Job = {
  id: string; version: number; externalId: string; customerReference: string; status: string;
  scheduledAt: string | null; blocker: string | null; assigneeId: string | null;
};
export type Detail = {
  job: Job;
  milestones: { id: string; title: string; dueAt: string; status: string }[];
  events: { id: string; kind: string; note: string; details: Record<string, unknown> }[];
};

export async function readSeededJob(externalId: string): Promise<Detail> {
  const { items } = await relay<{ items: Job[] }>(`/jobs?search=${encodeURIComponent(externalId)}`);
  const job = items.find((item) => item.externalId === externalId);
  if (!job) throw new Error(`Synthetic job ${externalId} was not found.`);
  return relay(`/jobs/${encodeURIComponent(job.id)}`);
}

export function jobUrl(id: string) {
  return relayOrigin + "/relay/jobs/" + encodeURIComponent(id);
}
