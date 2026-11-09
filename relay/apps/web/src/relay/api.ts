export type RelayRole = "organization_admin" | "branch_dispatcher" | "on_call_responder" | "auditor" | "platform_admin";
export type Channel = "voice" | "sms";
export interface Branch { id: string; name: string; timezone: string }
export interface Person {
  id: string; displayName: string; email: string; role: RelayRole; branchId: string;
  active?: boolean; phone?: string | null; phoneVerified?: boolean;
}
export interface Session {
  user: Person; organization: { id: string; name: string }; branches: Branch[];
  csrfToken: string; providerMode: string;
}
export interface Commitment {
  commitmentId: string; workOrderId: string; branchId: string; status: string; dueAt: string;
  createdAt: string; acknowledgedAt: string | null; breachedAt: string | null;
  ownerRecipientId: string | null; nextEscalationAt: string | null;
  declinedRecipientIds?: string[];
  workOrder: { externalId: string; customerReference: string; priority: string; sourceKind: string; sourceReceivedAt?: string };
  recipients: { recipientId: string; personId: string; displayName: string }[];
  sourceAcceptance: { status: string; recordedAt: string | null; recordedBy: string | null };
}
export interface QueueItem { commitment: Commitment; note?: string | null }
export interface EventRecord { eventId: string; eventType: string; occurredAt: string; actorId: string; payload?: Record<string, unknown> }
export interface Attempt {
  id?: string; attemptId?: string; channel: Channel; status: string; recipientId: string;
  scheduledAt?: string; createdAt?: string; updatedAt?: string; errorCode?: string | null;
}
export interface Detail { commitment: Commitment; events: EventRecord[]; attempts: Attempt[]; note?: string | null }
export interface Settings { branchId: string; version: number; recipientIds: string[]; intervalSeconds: number; channels: Channel[]; timezone: string }
export interface MfaChallenge { mfaRequired: boolean; enrollmentRequired?: boolean; csrfToken: string }
export type AuthResult = Session | MfaChallenge;

let csrfToken: string | null = null;
export function useSessionToken(session: { csrfToken: string } | null): void { csrfToken = session?.csrfToken ?? null; }
export class RelayApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function commandKey(): string { return crypto.randomUUID(); }
export async function relayRequest<T>(path: string, options: { method?: string; body?: unknown; key?: string; unauthenticated?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken && !options.unauthenticated) headers["X-CSRF-Token"] = csrfToken;
  if (options.key) headers["Idempotency-Key"] = options.key;
  const response = await fetch(`/api/relay/v1${path}`, {
    method, headers, credentials: "same-origin", cache: "no-store",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const data = response.status === 204 ? undefined : await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/") && typeof window !== "undefined") window.dispatchEvent(new Event("northstar:relay-session-expired"));
    throw new RelayApiError(response.status, String(data?.error ?? data?.code ?? "request_failed"), String(data?.message ?? ""));
  }
  if (data === undefined && response.status !== 204) throw new RelayApiError(502, "invalid_response", "");
  return data as T;
}
export function isMfaChallenge(value: AuthResult): value is MfaChallenge { return "mfaRequired" in value && value.mfaRequired; }
export function isAdministrator(session: Session): boolean { return session.user.role === "organization_admin"; }
export function canDispatch(session: Session): boolean { return isAdministrator(session) || session.user.role === "branch_dispatcher"; }
export function workOrderPath(commitment: Commitment): string { return `/work-orders/${encodeURIComponent(commitment.workOrderId)}`; }
export async function getDetail(id: string): Promise<Detail> {
  const detail = await relayRequest<Omit<Detail, "attempts"> & { attempts: { attempt_id: string; recipient_id: string; channel: Channel; status: string; created_at: string; scheduled_at?: string; last_error?: string | null }[] }>(`/work-orders/${encodeURIComponent(id)}`);
  return { ...detail, attempts: detail.attempts.map((attempt) => ({
    attemptId: attempt.attempt_id, recipientId: attempt.recipient_id, channel: attempt.channel,
    status: attempt.status, createdAt: attempt.created_at,
    ...(attempt.scheduled_at === undefined ? {} : { scheduledAt: attempt.scheduled_at }),
    ...(attempt.last_error === undefined ? {} : { errorCode: attempt.last_error }),
  })) };
}
