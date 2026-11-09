import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import twilio from "twilio";

export type RelayChannel = "voice" | "sms";
export type RelayLocale = "en" | "fr";
export interface RelayDelivery {
  attemptId: string;
  channel: RelayChannel;
  destination: string;
  locale: RelayLocale;
  actionToken: string;
}
export interface RelayProviderResult { reference: string; simulated: boolean }
export interface RelayProvider { send(delivery: RelayDelivery): Promise<RelayProviderResult> }
export interface RelayTwilioClient {
  calls: { create(payload: Record<string, unknown>): Promise<{ sid: string }> };
  messages: { create(payload: Record<string, unknown>): Promise<{ sid: string }> };
}
export interface RelayTwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  publicOrigin: string;
  allowedNumbers: readonly string[];
}

export class DefiniteDeliveryFailure extends Error {
  constructor(public readonly code: string) { super(code); }
}

export function opaqueActionToken(): string { return randomBytes(32).toString("base64url"); }
export function actionTokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function constantTimeTextEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}
export function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
export function relayVoiceInstructions(actionUrl: string, locale: RelayLocale): string {
  const response = new twilio.twiml.VoiceResponse();
  const gather = response.gather({ action: actionUrl, method: "POST", input: ["dtmf"], numDigits: 1, timeout: 8, actionOnEmptyResult: true });
  gather.say({ language: locale === "fr" ? "fr-CA" : "en-CA" }, locale === "fr"
    ? "Northstar Relay. Une demande attend un responsable. Appuyez sur 1 pour accepter la responsabilité, ou sur 9 pour refuser."
    : "Northstar Relay. A request needs an owner. Press 1 to accept responsibility, or press 9 to decline.");
  response.hangup();
  return response.toString();
}
export function relayVoiceResult(result: "accepted" | "declined" | "unavailable" | "no_input", locale: RelayLocale = "en"): string {
  const labels = {
    en: { accepted: "Responsibility recorded. Open Relay for details. Source portal acceptance is a separate action.", declined: "Decline recorded.", unavailable: "This request is no longer available. Open Relay to check its status.", no_input: "No valid response was received. No responsibility was accepted." },
    fr: { accepted: "Responsabilité enregistrée. Ouvrez Relay pour les détails. L'acceptation dans le portail source est une action distincte.", declined: "Refus enregistré.", unavailable: "Cette demande n'est plus disponible. Ouvrez Relay pour vérifier son état.", no_input: "Aucune réponse valide reçue. Aucune responsabilité acceptée." },
  };
  const response = new twilio.twiml.VoiceResponse();
  response.say({ language: locale === "fr" ? "fr-CA" : "en-CA" }, labels[locale][result]);
  response.hangup();
  return response.toString();
}

export class RelayTwilioProvider implements RelayProvider {
  private readonly client: RelayTwilioClient;
  constructor(readonly config: RelayTwilioConfig, client?: RelayTwilioClient) {
    const origin = new URL(config.publicOrigin);
    if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("Live Relay requires a canonical HTTPS origin");
    if (!/^AC[0-9a-f]{32}$/i.test(config.accountSid) || !config.authToken) throw new Error("Twilio credentials are required");
    if (!/^\+[1-9]\d{7,14}$/.test(config.fromNumber)) throw new Error("A valid Twilio sender is required");
    if (!config.allowedNumbers.length || config.allowedNumbers.some(n => !/^\+1\d{10}$/.test(n))) throw new Error("Explicit North American test destination allowlist is required");
    this.client = client ?? twilio(config.accountSid, config.authToken, { timeout: 10_000, autoRetry: false }) as unknown as RelayTwilioClient;
  }

  async send(delivery: RelayDelivery): Promise<RelayProviderResult> {
    if (!this.config.allowedNumbers.includes(delivery.destination)) throw new DefiniteDeliveryFailure("destination_not_allowlisted");
    if (!/^[a-zA-Z0-9_-]{10,100}$/.test(delivery.attemptId) || !/^[a-zA-Z0-9_-]{32,100}$/.test(delivery.actionToken)) throw new DefiniteDeliveryFailure("invalid_attempt_capability");
    const callback = `${this.config.publicOrigin}/api/relay/v1/providers/twilio/${encodeURIComponent(delivery.attemptId)}`;
    try {
      const result = delivery.channel === "voice"
        ? await this.client.calls.create({
          to: delivery.destination, from: this.config.fromNumber, twiml: relayVoiceInstructions(`${callback}/gather`, delivery.locale),
          statusCallback: `${callback}/status`, statusCallbackMethod: "POST", statusCallbackEvent: ["initiated", "ringing", "answered", "completed"], timeout: 25,
        })
        : await this.client.messages.create({
          to: delivery.destination, from: this.config.fromNumber,
          body: `${delivery.locale === "fr" ? "Northstar Relay : une demande attend un responsable." : "Northstar Relay: a request needs an owner."} ${this.config.publicOrigin}/relay/action/${delivery.actionToken}`,
          statusCallback: `${callback}/status`, validityPeriod: 60,
        });
      return { reference: result.sid, simulated: false };
    } catch (error) {
      const status = Number((error as { status?: number }).status);
      if (status >= 400 && status < 500 && status !== 408) throw new DefiniteDeliveryFailure(`provider_rejected_${status}`);
      // Timeout/network/5xx may follow a successful submission; do not blindly retry.
      throw new Error("provider_outcome_uncertain");
    }
  }

  async sendVerification(destination: string, code: string): Promise<void> {
    if (!this.config.allowedNumbers.includes(destination) || !/^\d{6}$/.test(code)) throw new DefiniteDeliveryFailure("verification_not_permitted");
    await this.client.messages.create({ to: destination, from: this.config.fromNumber, body: `Northstar Relay: ${code}. Verification code / Code de vérification.`, validityPeriod: 300 });
  }
}

export class RelaySimulatedProvider implements RelayProvider {
  readonly sent: RelayDelivery[] = [];
  async send(delivery: RelayDelivery): Promise<RelayProviderResult> {
    this.sent.push(structuredClone(delivery));
    return { reference: `simulated:${delivery.attemptId}`, simulated: true };
  }
}

export function verifyRelayTwilioCallback(config: Pick<RelayTwilioConfig, "accountSid" | "authToken" | "publicOrigin">, path: string, signature: string, fields: Record<string, string>): boolean {
  if (fields.AccountSid !== config.accountSid || !signature || !path.startsWith("/api/relay/v1/providers/twilio/")) return false;
  return twilio.validateRequest(config.authToken, signature, `${config.publicOrigin}${path}`, fields);
}

export function dtmfAction(digits: string | undefined): "acknowledge" | "decline" | null {
  return digits === "1" ? "acknowledge" : digits === "9" ? "decline" : null;
}
