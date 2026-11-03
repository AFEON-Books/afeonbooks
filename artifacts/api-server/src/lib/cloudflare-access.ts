import { createPublicKey, verify, type webcrypto } from "node:crypto";
import type { Request } from "express";

type AccessClaims = {
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iss?: string;
  email?: string;
};

type AccessKey = webcrypto.JsonWebKey & { kid?: string };

const isProduction = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
const KEY_CACHE_MS = 5 * 60 * 1000;
const MAX_ASSERTION_LENGTH = 16_384;
let cachedKeys: { expiresAt: number; keys: AccessKey[] } | undefined;
let keysRequest: Promise<AccessKey[]> | undefined;

function getTeamDomain(): URL {
  const configured = process.env.CF_ACCESS_TEAM_DOMAIN;
  if (!configured) throw new Error("CF_ACCESS_TEAM_DOMAIN is not configured");
  const domain = new URL(configured.startsWith("https://") ? configured : `https://${configured}`);
  if (
    domain.protocol !== "https:" ||
    !domain.hostname.endsWith(".cloudflareaccess.com") ||
    domain.pathname !== "/" ||
    domain.search ||
    domain.hash
  ) {
    throw new Error("CF_ACCESS_TEAM_DOMAIN must be a Cloudflare Access team domain");
  }
  return domain;
}

function getAllowedAudiences(): Set<string> {
  const configured = process.env.CF_ACCESS_AUDS ?? "";
  const audiences = configured.split(",").map((value) => value.trim()).filter(Boolean);
  if (audiences.length === 0) throw new Error("CF_ACCESS_AUDS must contain the protected application audience tags");
  return new Set(audiences);
}

async function fetchAccessKeys(force = false): Promise<AccessKey[]> {
  if (!force && cachedKeys && cachedKeys.expiresAt > Date.now()) return cachedKeys.keys;
  if (keysRequest) return keysRequest;

  keysRequest = (async () => {
    const teamDomain = getTeamDomain();
    const response = await fetch(new URL("/cdn-cgi/access/certs", teamDomain), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Cloudflare Access keys request failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !Array.isArray((body as { keys?: unknown }).keys)) {
      throw new Error("Cloudflare Access returned an invalid keys document");
    }
    const keys = (body as { keys: AccessKey[] }).keys;
    if (!keys.length || keys.some((key) => key.kty !== "RSA" || typeof key.kid !== "string" || !key.n || !key.e)) {
      throw new Error("Cloudflare Access returned invalid signing keys");
    }
    cachedKeys = { keys, expiresAt: Date.now() + KEY_CACHE_MS };
    return keys;
  })();

  try {
    return await keysRequest;
  } finally {
    keysRequest = undefined;
  }
}

function decodeSegment(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("Invalid Cloudflare Access JWT encoding");
  return Buffer.from(segment, "base64url");
}

function parseJson<T>(segment: string): T {
  return JSON.parse(decodeSegment(segment).toString("utf8")) as T;
}

async function verifyWithKeys(
  header: { alg?: string; kid?: string },
  signingInput: string,
  signature: Buffer,
): Promise<boolean> {
  if (header.alg !== "RS256" || typeof header.kid !== "string") return false;
  let keys = await fetchAccessKeys();
  let key = keys.find((candidate) => candidate.kid === header.kid);
  if (!key) {
    keys = await fetchAccessKeys(true);
    key = keys.find((candidate) => candidate.kid === header.kid);
  }
  if (!key) return false;
  return verify(
    "RSA-SHA256",
    Buffer.from(signingInput),
    createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" }),
    signature,
  );
}

export async function verifyCloudflareAccessAssertion(request: Request): Promise<AccessClaims | undefined> {
  const assertion = request.get("cf-access-jwt-assertion") ?? request.cookies?.afeonbooks_access;
  if (!assertion) {
    if (!isProduction) return undefined;
    throw new Error("Cloudflare Access assertion is required");
  }
  if (assertion.length > MAX_ASSERTION_LENGTH) throw new Error("Cloudflare Access assertion is too large");

  const parts = assertion.split(".");
  if (parts.length !== 3) throw new Error("Cloudflare Access assertion is malformed");
  const header = parseJson<{ alg?: string; kid?: string }>(parts[0]);
  const claims = parseJson<AccessClaims>(parts[1]);
  if (!await verifyWithKeys(header, `${parts[0]}.${parts[1]}`, decodeSegment(parts[2]))) {
    throw new Error("Cloudflare Access assertion signature is invalid");
  }

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const expectedIssuer = getTeamDomain().origin;
  if (
    claims.iss !== expectedIssuer ||
    !audiences.some((audience) => typeof audience === "string" && getAllowedAudiences().has(audience)) ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= now ||
    (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 60))
  ) {
    throw new Error("Cloudflare Access assertion claims are invalid");
  }
  return claims;
}
