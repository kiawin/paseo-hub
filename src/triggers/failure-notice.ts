import { decodeEntitlementDenialFailureReason } from "../entitlements/denial.js";
import type { Database } from "../db/types.js";

export function isExecutionLimitDenial(reason: string): boolean {
  const denial = decodeEntitlementDenialFailureReason(reason);
  return (
    denial?.entitlement === "executions.monthly" && denial.kind === "meter" && denial.limit !== null
  );
}

export function missingBillingUrl(): Promise<string> {
  throw new Error("billing URL unavailable");
}

const LAST_MESSAGE_NOTICE_MAX_CHARS = 1_500;

/** The agent's own words, quoted and cut short. It is not a verified result. */
function quoteLastMessage(message: string): string {
  const text = message.trim();
  const cut =
    text.length > LAST_MESSAGE_NOTICE_MAX_CHARS
      ? `${text.slice(0, LAST_MESSAGE_NOTICE_MAX_CHARS)}…`
      : text;
  return cut
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export async function agentFailureNotice(
  reason: string,
  organizationId: string,
  billingUrlForOrganization: (organizationId: string) => Promise<string>,
  lastAssistantMessage?: string,
  now = new Date(),
): Promise<string> {
  if (!isExecutionLimitDenial(reason)) {
    const notice = `Paseo agent failed: ${reason}`;
    return lastAssistantMessage === undefined || lastAssistantMessage.trim() === ""
      ? notice
      : `${notice}\n\nThe agent's last message before it stopped:\n${quoteLastMessage(lastAssistantMessage)}`;
  }
  const denial = decodeEntitlementDenialFailureReason(reason)!;
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(now);
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const resetDay = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(reset);
  const billingUrl = await billingUrlForOrganization(organizationId);
  return `This org has used its ${denial.limit} free runs for ${month}. Runs reset on ${resetDay}, or upgrade to Pro under Billing: ${billingUrl}`;
}

export async function organizationBillingUrl(
  database: Database,
  publicBaseUrl: string,
  organizationId: string,
): Promise<string> {
  const slug = await database.findOrganizationSlugById(organizationId);
  if (slug === undefined) throw new Error(`organization not found: ${organizationId}`);
  return new URL(`/o/${encodeURIComponent(slug)}/settings/billing`, publicBaseUrl).toString();
}
