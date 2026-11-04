async function isMaintenanceMode() {
  const response = await fetch("https://api.afeonbooks.com/api/maintenance/status", {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Maintenance status check failed with status ${response.status}`);
  }

  const data = await response.json();
  if (!data || typeof data.enabled !== "boolean") {
    throw new Error("Maintenance status check returned an invalid response");
  }
  return data.enabled;
}

function pdfEscape(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E]/g, "?");
}

function makePdf(lines) {
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 54;
  const lineHeight = 16;
  const maxLinesPerPage = 43;
  const pages = [];

  for (let i = 0; i < lines.length; i += maxLinesPerPage) pages.push(lines.slice(i, i + maxLinesPerPage));
  if (pages.length === 0) pages.push([""]);

  const objects = [];
  const pageObjectIds = [];
  const contentObjectIds = [];
  let nextId = 3;
  for (const _pageLines of pages) {
    pageObjectIds.push(nextId++);
    contentObjectIds.push(nextId++);
  }
  const fontObjectId = nextId++;
  const encoder = new TextEncoder();

  const makeContent = (pageLines) => {
    const commands = ["BT", "/F1 11 Tf", `${margin} ${pageHeight - margin} Td`];
    pageLines.forEach((line, index) => {
      if (index > 0) commands.push(`0 -${lineHeight} Td`);
      commands.push(`(${pdfEscape(line)}) Tj`);
    });
    commands.push("ET");
    return commands.join("\n");
  };

  const pageKids = pageObjectIds.map((id) => `${id} 0 R`).join(" ");
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageKids}] /Count ${pages.length} >>`;
  pages.forEach((pageLines, index) => {
    const pageId = pageObjectIds[index];
    const contentId = contentObjectIds[index];
    const content = makeContent(pageLines);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`;
  });
  objects[fontObjectId] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  const chunks = ["%PDF-1.4\n"];
  const offsets = new Array(objects.length).fill(0);
  let byteLength = encoder.encode(chunks[0]).length;
  for (let id = 1; id < objects.length; id++) {
    if (!objects[id]) continue;
    const objectText = `${id} 0 obj\n${objects[id]}\nendobj\n`;
    offsets[id] = byteLength;
    chunks.push(objectText);
    byteLength += encoder.encode(objectText).length;
  }
  const xrefOffset = byteLength;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  chunks.push(xref);
  chunks.push(`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return encoder.encode(chunks.join(""));
}

async function getCheckoutFieldLabels() {
  try {
    const response = await fetch("https://api.afeonbooks.com/api/content", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      console.error("Unable to load checkout field labels for order PDF", response.status);
      return new Map();
    }

    const content = await response.json();
    const fields = Array.isArray(content.checkoutFields) ? content.checkoutFields : [];
    return new Map(
      fields
        .filter((field) => typeof field?.id === "string" && typeof field?.label === "string")
        .map((field) => [field.id, field.label])
    );
  } catch (error) {
    console.error("Unable to load checkout field labels for order PDF", error);
    return new Map();
  }
}

async function orderPdfResponse(request, orderId) {
  const apiUrl = new URL(`https://api.afeonbooks.com/api/orders/${encodeURIComponent(orderId)}`);
  const headers = new Headers({ Accept: "application/json" });
  const accessToken = request.headers.get("X-Order-Access-Token");
  const cookie = request.headers.get("Cookie");
  if (accessToken) headers.set("X-Order-Access-Token", accessToken);
  if (cookie) headers.set("Cookie", cookie);
  const apiResponse = await fetch(new Request(apiUrl, { method: "GET", headers }));

  if (!apiResponse.ok) {
    return new Response(apiResponse.status === 404 ? "Order not found" : "Unable to load order", {
      status: apiResponse.status === 404 ? 404 : 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const order = await apiResponse.json();
  const fieldLabels = await getCheckoutFieldLabels();
  const customFields = order.customFields && typeof order.customFields === "object"
    ? order.customFields
    : {};
  const customFieldEntries = Object.entries(customFields)
    .filter(([, value]) => value != null && String(value).trim() !== "");
  const customFieldLines = customFieldEntries.map(([id, value]) =>
    `${fieldLabels.get(id) || id}: ${value}`
  );
  const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
  const lines = [
    "AFEON BOOKS",
    "Customer Order Receipt",
    "",
    `Order #${order.id}`,
    `Status: ${order.status || "pending"}`,
    `Placed: ${order.createdAt ? new Date(order.createdAt).toLocaleString("en-US") : ""}`,
    "",
    "CUSTOMER",
    `Name: ${order.customerName || ""}`,
    `Email: ${order.customerEmail || ""}`,
    `Student ID: ${order.customerPhone || ""}`,
    ...(customFieldLines.length ? ["", "ADDITIONAL INFORMATION", ...customFieldLines] : []),
    "",
    "DELIVERY",
    order.classroom ? `Classroom: ${order.classroom}` : null,
    `Address: ${order.shippingAddress || ""}`,
    `${order.city || ""}, ${order.postalCode || ""}`,
    `Country: ${order.country || ""}`,
    "",
    "ITEMS",
    ...(Array.isArray(order.items) && order.items.length
      ? order.items.map((item) => `${item.quantity} x ${item.productName}  ${money(Number(item.unitPriceCents || 0) * Number(item.quantity || 0))}`)
      : ["No items"]),
    "",
    `Subtotal: ${money(order.subtotalCents)}`,
    `Shipping: ${money(order.shippingCents)}`,
    `TOTAL: ${money(order.totalCents)} ${order.currency || "USD"}`,
    `Payment: ${order.paymentMethod || ""}`,
    order.notes ? `Notes: ${order.notes}` : null,
  ].filter((line) => line !== null);

  return new Response(makePdf(lines), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="afeonbooks-order-${order.id}.pdf"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

function maintenanceResponse() {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { display: flex; flex-direction: column; width: 100%; height: 100vh; height: 100dvh; margin: 0; background: #101827; text-align: center; }
    .status-banner { flex: 0 0 auto; display: block; padding: 12px 20px; background: #9d2f20; color: #fff; font: 600 16px/1.5 system-ui, sans-serif; text-decoration: underline; text-underline-offset: 3px; }
    img { flex: 1 1 auto; min-height: 0; width: 100%; object-fit: contain; }
  </style>
</head>
<body>
  <a class="status-banner" href="https://status.afeonbooks.com/" target="_blank" rel="noopener noreferrer">Service Under Maintenance — view status updates</a>
  <img src="https://msxfhfdeqxqvjuypcspm.supabase.co/storage/v1/object/public/photos/totec-maintenence.svg" alt="Maintenance in progress">
</body>
</html>`,
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Retry-After": "60",
        "Cache-Control": "no-store",
      },
    }
  );
}

function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function directoryKeyMatches(url, env) {
  return typeof env.DIRECTORY_KEY === "string" && env.DIRECTORY_KEY.length > 0 && url.searchParams.get("key") === env.DIRECTORY_KEY;
}

async function getAdminUserFromSession(request) {
  const cookie = request.headers.get("Cookie");
  const headers = new Headers({ Accept: "application/json" });
  if (cookie) headers.set("Cookie", cookie);
  const sessionResponse = await fetch("https://api.afeonbooks.com/api/auth/me", {
    headers,
    redirect: "manual",
  });
  if (!sessionResponse.ok) {
    throw new Error(`Account session check failed with status ${sessionResponse.status}`);
  }
  const sessionPayload = await sessionResponse.json();
  if (!sessionPayload || !Object.hasOwn(sessionPayload, "user")) {
    throw new Error("Account session check returned an invalid response");
  }
  const user = sessionPayload.user ?? null;
  if (!user || (user.role !== "staff" && user.role !== "admin")) {
    return { user, organizationVerified: false };
  }

  const accessResponse = await fetch("https://api.afeonbooks.com/api/auth/admin/access", {
    headers,
    redirect: "manual",
  });
  if (accessResponse.status === 401) return { user: null, organizationVerified: false };
  if (accessResponse.status === 403) return { user, organizationVerified: false };
  if (!accessResponse.ok) {
    throw new Error(`Admin organization check failed with status ${accessResponse.status}`);
  }
  return { user, organizationVerified: true };
}

function githubOrganizationRedirect(request) {
  const signInUrl = new URL("https://afeonbooks.com/api/auth/github/start");
  signInUrl.searchParams.set("return_to", request.url);
  return Response.redirect(signInUrl.toString(), 302);
}

function sourceAuthError(status, message) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unable to verify access</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:38rem;margin:12vh auto;padding:24px;color:#171717;background:#f5f3ee}main{background:#fff;padding:32px;border:1px solid #ddd}a{color:#111827;font-weight:600}</style></head><body><main><h1>Unable to verify staff access</h1><p>${message}</p><p><a href="https://afeonbooks.com/api/auth/github/start?return_to=https%3A%2F%2Fsource.afeonbooks.com%2F">Sign in with GitHub</a></p></main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

function sourceDashboardHtml() {
  const panels = [
    { name: "GitHub", url: "https://github.com/acdu1/afeonbooks", embed: false },
    { name: "GitHub Codespaces", url: "https://ubiquitous-guacamole-x545p5p7996439pxj.github.dev/", embed: false },
    { name: "Cloudflare Dashboard", url: "https://dash.cloudflare.com/a130548b1748b2365a5c0e027fe3ebd8/home", embed: false },
    { name: "Supabase", url: "https://supabase.com/dashboard/project/msxfhfdeqxqvjuypcspm", embed: false },
    { name: "Render", url: "https://dashboard.render.com/web/srv-da57c6jbc2fs738388lg", embed: false },
    { name: "StatusPage", url: "https://status.afeonbooks.com/", embed: false },
    { name: "Reedsy Book Editor", url: "https://editor.reedsy.com/", embed: true },
  ];

  const iframeMarkup = panels
    .map(
      ({ name, url, embed }) => `
        <section class="panel">
          <div class="panel-header">
            <h2>${name}</h2>
            <a href="${url}" target="_blank" rel="noopener noreferrer">Open in new tab</a>
          </div>
          ${embed
            ? `<iframe
                src="${url}"
                title="${name}"
                loading="lazy"
                referrerpolicy="no-referrer"
                sandbox="allow-forms allow-popups allow-scripts allow-same-origin"
              ></iframe>`
            : `<div class="embed-unavailable">
                <p>This service does not allow its dashboard to be embedded here. Open it in a new tab to sign in and use it.</p>
                <a class="open-service" href="${url}" target="_blank" rel="noopener noreferrer">Open ${name}</a>
              </div>`
          }
        </section>
      `,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AFEON Books Infrastructure</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f3ee;
        --panel: #fff;
        --text: #171717;
        --muted: #5b5b5b;
        --border: rgba(23, 23, 23, 0.12);
        --accent: #111827;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .page {
        max-width: 1400px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        margin-bottom: 24px;
      }
      .eyebrow {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: var(--muted);
      }
      h1 {
        margin: 6px 0 0;
        font-size: clamp(2rem, 3vw, 2.8rem);
        line-height: 1.1;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
        gap: 24px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
      }
      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border-bottom: 1px solid var(--border);
        padding: 12px 16px;
      }
      .panel-header h2 {
        margin: 0;
        font-size: 0.95rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .panel-header a {
        color: var(--accent);
        text-decoration: none;
        font-weight: 600;
        font-size: 0.8rem;
      }
      .embed-unavailable {
        min-height: 180px;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        justify-content: center;
        gap: 16px;
        padding: 24px;
      }
      .embed-unavailable p {
        max-width: 34rem;
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
      }
      .open-service {
        display: inline-flex;
        align-items: center;
        min-height: 42px;
        padding: 0 16px;
        background: var(--accent);
        color: #fff;
        text-decoration: none;
        font-size: 0.85rem;
        font-weight: 600;
      }
      .open-service:hover { opacity: 0.86; }
      iframe {
        display: block;
        width: 100%;
        height: 520px;
        border: 0;
        background: #fff;
      }
      @media (max-width: 700px) {
        .page { padding-top: 20px; }
        iframe { height: 400px; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="topbar">
        <div>
          <div class="eyebrow">AFEON Books</div>
          <h1>Infrastructure dashboard</h1>
        </div>
      </div>
      <div class="grid">
        ${iframeMarkup}
      </div>
    </div>
  </body>
</html>`;
}

function directoryResponse(status = 404, body = "Not Found") {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function directoryHtml(files, key, selectedFile = "") {
  const folders = new Map();
  for (const file of files) {
    const parts = file.split("/");
    const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(file);
  }
  const link = (file) => `/directory/file/${file.split("/").map(encodeURIComponent).join("/")}?key=${encodeURIComponent(key)}`;
  const tree = [...folders.entries()].map(([folder, folderFiles]) => `<section><h2>${escapeHtml(folder === "." ? "Root" : folder)}</h2><ul>${folderFiles.map((file) => `<li><a href="${escapeHtml(link(file))}">${escapeHtml(file.split("/").at(-1))}</a></li>`).join("")}</ul></section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AFEON Books Files</title><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;background:#f8f5ef;color:#171717}section{background:#fff;border:1px solid #ddd;margin:16px 0;padding:16px}h1{margin-bottom:28px}h2{font-size:16px;margin-top:0}ul{list-style:none;padding:0;margin-bottom:0}li{padding:6px 0}a{color:#17624a;text-decoration:none}a:hover{text-decoration:underline}</style></head><body><h1>AFEON Books deployed files</h1>${selectedFile ? `<p>Viewing <strong>${escapeHtml(selectedFile)}</strong></p>` : ""}${tree}</body></html>`;
}

async function directoryResponseFor(request, env) {
  const url = new URL(request.url);
  if (!directoryKeyMatches(url, env)) return directoryResponse(404);
  const manifestResponse = await env.ASSETS.fetch(new Request(new URL("/directory-manifest.json", request.url), request));
  if (!manifestResponse.ok) return directoryResponse(503, "Directory manifest is not available. Rebuild the site first.");
  const files = await manifestResponse.json();
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) return directoryResponse(503, "Invalid directory manifest");
  const fileMatch = url.pathname.match(/^\/directory\/file\/(.+)$/);
  if (fileMatch) {
    let file;
    try {
      file = decodeURIComponent(fileMatch[1]).replace(/^\/+/, "");
    } catch {
      return directoryResponse(404);
    }
    if (!files.includes(file) || file.includes("..")) return directoryResponse(404);
    const assetResponse = await env.ASSETS.fetch(new Request(new URL(`/${file}`, request.url), request));
    if (!assetResponse.ok) return directoryResponse(404);
    return new Response(assetResponse.body, { status: 200, headers: { ...Object.fromEntries(assetResponse.headers), "Cache-Control": "no-store" } });
  }
  if (url.pathname === "/directory" || url.pathname === "/directory/") return new Response(directoryHtml(files, url.searchParams.get("key")), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  return directoryResponse(404);
}

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/directory" || path === "/directory/" || path.startsWith("/directory/file/") || path === "/directory-manifest.json") return directoryResponseFor(request, env);

if (url.hostname === "source.afeonbooks.com") {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  const isSourceDashboardRoute = path === "/" || path === "/source" || path === "/source/" || path === "/infra" || path === "/infra/";
  if (!isSourceDashboardRoute) {
    return env.ASSETS.fetch(request);
  }

  let user;
  try {
    user = await getAdminUserFromSession(request);
  } catch (error) {
    console.error(JSON.stringify({
      message: "Source dashboard admin session check failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return sourceAuthError(503, "The session check failed. Please try again shortly.");
  }

  if (!user?.user) return githubOrganizationRedirect(request);

  if (user.user.role !== "staff" && user.user.role !== "admin") {
    return sourceAuthError(403, "A staff or admin account is required to access this dashboard.");
  }
  if (!user.organizationVerified) return githubOrganizationRedirect(request);

  return new Response(sourceDashboardHtml(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

if (url.hostname === "authn.afeonbooks.com") {
  if (path.startsWith("/api/")) {
    const apiUrl = new URL(`https://api.afeonbooks.com${path}${url.search}`);
    return fetch(new Request(apiUrl, request));
  }

  if (path === "/" || path === "/account" || path === "/account/" || /^\/(?:sign-in|account-check)\/[a-f0-9]{32}$/.test(path)) {
    return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
  }

  return env.ASSETS.fetch(request);
}

    if (path.startsWith("/api/")) {
      const apiUrl = new URL(`https://api.afeonbooks.com${path}${url.search}`);
      return fetch(new Request(apiUrl, request));
    }

    const isAdminRoute = path === "/admin" || path.startsWith("/admin/");
    const isMailSystem = url.hostname === "mailsystem.afeonbooks.com";

    if (
      !isMailSystem &&
      !isAdminRoute &&
      request.method === "GET" &&
      request.headers.get("Accept")?.includes("text/html") &&
      await isMaintenanceMode()
    ) {
      return maintenanceResponse();
    }

    if (path === "/api/debug-info") {
      const version = env.CF_VERSION_METADATA;
      return Response.json(
        { build: version?.id ?? "unknown", ip: request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown", host: url.host },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const orderPdfMatch = path.match(/^\/order\/([^/]+)\/pdf\/?$/);
    if (orderPdfMatch) return orderPdfResponse(request, orderPdfMatch[1]);

    const fetchSiteIndex = () => env.ASSETS.fetch(new Request(new URL("/", request.url), request));
    const fetchAdminIndex = () => env.ASSETS.fetch(new Request(new URL("/admin/", request.url), request));
    const fetchAdminPos = () => env.ASSETS.fetch(new Request(new URL("/admin/pos", request.url), request));

    if (path === "/admin/admin" || path === "/admin/admin/") return Response.redirect(new URL("/admin/", request.url), 301);
    if (path.startsWith("/admin/admin/")) return Response.redirect(new URL(path.replace(/^\/admin\/admin/, "/admin"), request.url), 301);
    if (path === "/admin/pos" || path === "/admin/pos/") return fetchAdminPos();
    if (path === "/admin/zoho-mail" || path === "/admin/zoho-mail/") return fetchAdminIndex();
    if (path === "/admin" || path === "/admin/" || (path.startsWith("/admin/") && !path.split("/").pop()?.includes("."))) return fetchAdminIndex();

    const fetchPickupIndex = () => env.ASSETS.fetch(new Request(new URL("/pickup/", request.url), request));
    if (path === "/pickup" || path === "/pickup/" || (path.startsWith("/pickup/") && !path.split("/").pop()?.includes("."))) return fetchPickupIndex();

    if (/^\/order\/[^/]+\/?$/.test(path)) {
      return fetchSiteIndex();
    }

    if (path === "/account" || path === "/account/" || /^\/(?:sign-in|account-check)\/[a-f0-9]{32}$/.test(path)) {
      return fetchSiteIndex();
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;
    if (!path.split("/").pop()?.includes(".")) {
      const notFoundPage = await fetchSiteIndex();
      return new Response(notFoundPage.body, {
        status: 200,
        headers: notFoundPage.headers,
      });
    }
    return new Response("Not Found", { status: 404 });
}

export default {
  async fetch(request, env) {
    try {
      const response = await handleRequest(request, env);
      if (response.status === 502 || response.status === 503) {
        return addSecurityHeaders(maintenanceResponse());
      }
      return addSecurityHeaders(response);
    } catch (error) {
      console.error("Worker request failed; serving maintenance page", error);
      return addSecurityHeaders(maintenanceResponse());
    }
  },
};
