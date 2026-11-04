function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export interface EmailTemplateValues {
  brandName: string;
  emailFromName: string;
  emailSubject: string;
  emailHeading: string;
  emailIntro: string;
  emailButtonLabel: string;
  emailFooter: string;
  emailAccentColor: string;
  defaultShippingLabel: string;
  defaultShippingAddress: string;
  defaultShippingCity: string;
  defaultShippingPostalCode: string;
  defaultShippingCountry: string;
  footerNote: string;
}

const SAMPLE = {
  customerName: "Riley Anderson",
  orderId: "1042",
  total: fmt(1499),
  paymentMethod: "Cash on Delivery",
  classroom: "Room 204",
};

function applyVars(template: string): string {
  const map: Record<string, string> = SAMPLE;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const v = map[key];
    return v === undefined ? `{{${key}}}` : v;
  });
}

export function renderEmailPreview(v: EmailTemplateValues): string {
  const accent = /^#[\da-f]{6}$/i.test(v.emailAccentColor || "") ? v.emailAccentColor : "#7DD3EA";
  const heading = applyVars(v.emailHeading);
  const intro = applyVars(v.emailIntro);
  const footer = applyVars(v.emailFooter);
  const buttonLabel = applyVars(v.emailButtonLabel);
  const introHtml = escapeHtml(intro).replace(/\n/g, "<br>");
  const footerHtml = escapeHtml(footer).replace(/\n/g, "<br>");
  const useDefault = !!v.defaultShippingAddress;
  const shippingHtml = [
    useDefault ? `<strong>Classroom ${SAMPLE.classroom}</strong>` : "",
    useDefault ? escapeHtml(v.defaultShippingAddress) : "123 Sample St",
    useDefault
      ? `${escapeHtml(v.defaultShippingCity)}, ${escapeHtml(v.defaultShippingPostalCode)}`
      : "Sampletown, 00000",
    useDefault ? escapeHtml(v.defaultShippingCountry) : "USA",
  ]
    .filter(Boolean)
    .join("<br>");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="815" cellpadding="0" cellspacing="0" style="max-width:815px;width:100%;background:#fff;border:1px solid #eee;border-top:14px solid ${accent};">
<tr><td style="padding:30px 50px 0;"><img src="https://afeonbooks.com/afeonbooks-logo.png" width="100" height="100" alt="AFEON Books" style="display:block;width:100px;height:100px;object-fit:contain;border:0;"></td></tr>
<tr><td style="padding:16px 50px 16px;">
<h1 style="margin:0;font-size:24px;line-height:1.3;font-weight:700;">${escapeHtml(heading)}</h1>
<p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:#333;">${introHtml}</p>
<p style="margin:24px 0 0;"><a href="#" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:700;font-size:14px;">${escapeHtml(buttonLabel)}</a></p>
<div style="margin-top:32px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#777;font-weight:700;">Order Summary</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-top:1px solid #eee;">
<tr><td style="padding:12px 0;border-bottom:1px solid #eee;font-size:14px;"><strong>The Terror Of The Evil Capybara</strong><br><span style="color:#666;font-size:12px;">Qty 1 × ${fmt(1499)}</span></td><td style="padding:12px 0;border-bottom:1px solid #eee;font-size:14px;text-align:right;font-weight:bold;">${fmt(1499)}</td></tr>
<tr><td style="padding:16px 0 0 0;font-size:14px;color:#666;">Subtotal</td><td style="padding:16px 0 0 0;font-size:14px;text-align:right;">${fmt(1499)}</td></tr>
<tr><td style="padding:6px 0;font-size:14px;color:#666;">Shipping</td><td style="padding:6px 0;font-size:14px;text-align:right;">Free</td></tr>
<tr><td style="padding:12px 0 0 0;font-size:16px;font-weight:bold;border-top:1px solid #eee;">Total</td><td style="padding:12px 0 0 0;font-size:16px;text-align:right;font-weight:bold;border-top:1px solid #eee;">${fmt(1499)}</td></tr>
</table>
<div style="margin-top:24px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#777;font-weight:700;">Shipping To</div><div style="margin-top:8px;font-size:14px;line-height:1.6;color:#333;">${shippingHtml}</div>
<div style="margin-top:24px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#777;font-weight:700;">Payment</div><div style="margin-top:8px;font-size:14px;color:#333;">${SAMPLE.paymentMethod}</div>
</td></tr>
${footer ? `<tr><td style="padding:24px 40px 32px;border-top:1px solid #eee;font-size:13px;line-height:1.6;color:#666;">${footerHtml}</td></tr>` : ""}
</table>
<div style="max-width:815px;margin:12px auto 0;padding:0 12px;font-size:16px;line-height:1.5;color:#222;text-align:center;">Copyright © AFEON Books.<div style="margin-top:22px;"><a href="https://afeonbooks.com" style="color:#222;text-decoration:none;">www.afeonbooks.com</a></div><div style="margin-top:16px;"><a href="https://go.afeonbooks.com/ins" aria-label="AFEON Books on Instagram" style="display:inline-block;width:28px;height:28px;border:3px solid #333;border-radius:9px;line-height:28px;text-decoration:none;"><span style="display:inline-block;vertical-align:middle;width:11px;height:11px;border:3px solid #333;border-radius:50%;"></span><span style="display:inline-block;vertical-align:top;margin:4px 0 0 1px;width:4px;height:4px;background:#333;border-radius:50%;"></span></a></div>${v.footerNote && v.footerNote !== "© 2026 AFR Group. All Rights Reserved." ? `<div style="margin-top:8px;">${escapeHtml(v.footerNote)}</div>` : ""}</div>
</td></tr></table>
</body></html>`;
}
