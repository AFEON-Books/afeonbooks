import { logger } from "./logger";

type SiteverifyResult = {
  success?: boolean;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
};

export async function verifyTurnstileToken(token: unknown, expectedAction: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET;
  const hostnames = new Set(
    (process.env.TURNSTILE_HOSTNAMES ?? "")
      .split(",")
      .map((hostname) => hostname.trim().toLowerCase().replace(/\.$/, ""))
      .filter(Boolean),
  );
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    return false;
  }
  if (!secret || hostnames.size === 0) {
    logger.error({ hasSecret: Boolean(secret), configuredHostnameCount: hostnames.size }, "Turnstile verification is not configured");
    return false;
  }

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ secret, response: token }),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, "Turnstile siteverify request failed");
      return false;
    }
    const result = await response.json() as SiteverifyResult;
    const valid = result.success === true
      && result.action === expectedAction
      && typeof result.hostname === "string"
      && hostnames.has(result.hostname.toLowerCase().replace(/\.$/, ""));
    if (!valid) {
      logger.warn({
        expectedAction,
        returnedAction: result.action,
        hostname: result.hostname,
        errorCodes: result["error-codes"],
        success: result.success,
      }, "Turnstile rejected token");
    }
    return valid;
  } catch (error) {
    logger.warn({ err: error }, "Turnstile siteverify request failed");
    return false;
  }
}