const productionOrigins = new Set([
  "https://afeonbooks.com",
  "https://www.afeonbooks.com",
  "https://api-usw-2.afeonbooks.com",
  "https://authn.afeonbooks.com",
  "https://source.afeonbooks.com",
  "https://usw-2.afeonbooks.com",
]);

export function isAllowedOrigin(origin: string): boolean {
  if (productionOrigins.has(origin)) return true;
  if (process.env.NODE_ENV === "production" || process.env.RENDER === "true") return false;

  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  } catch {
    return false;
  }
}
