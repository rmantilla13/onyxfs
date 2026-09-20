// lib/signin-email.js — the magic-link email.
//
// Pulled out of auth.js so it stays readable and so the brand drives it: the
// palette, name and mark all come from the resolved brand config, which means
// re-branding the deployment re-brands the sign-in email with no redeploy.
//
// Two rules learned the hard way, worth not relitigating:
//   1. Always send BOTH an HTML and a plain-text part. HTML-only auth mail
//      gets scored as phishing by Gmail and Outlook.
//   2. Never print the raw link in the body. A long opaque token shown as
//      text, next to a button whose href is a different-looking URL, is the
//      exact shape spam filters are trained on. The URL belongs in the
//      button's href and in the text part, nowhere else.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function signInEmail({ brand, linkUrl, email, host, origin }) {
  const p = brand.visual.palette;
  const name = brand.name;
  const subject = `Sign in to ${name}`;
  const mark = origin ? `${origin}${brand.visual.logo.markPath}` : '';

  const text = [
    subject,
    '',
    'Click the link below to sign in. It expires in 24 hours.',
    '',
    linkUrl,
    '',
    "If you didn't request this, you can ignore this email — only approved addresses can sign in.",
    '',
    `— ${name}`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <title>${esc(subject)}</title>
  </head>
  <body style="margin:0; padding:0; background:${p.paper}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${p.paper};">
      <tr>
        <td align="center" style="padding:40px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="540" style="max-width:540px; background:#FFFFFF; border-radius:12px; border:1px solid ${p.line};">
            <tr>
              <td style="padding:40px 40px 32px;">
                ${mark ? `<img src="${esc(mark)}" alt="${esc(name)}" width="44" height="44" style="display:block; border-radius:10px; border:0; margin-bottom:28px;" />` : ''}
                <h1 style="color:${p.ink}; font-weight:600; font-size:24px; margin:0 0 12px; letter-spacing:-0.02em; line-height:1.2;">${esc(subject)}</h1>
                <p style="color:${p.muted}; font-size:15px; line-height:1.55; margin:0 0 28px;">Click the button below to sign in. This link expires in 24&nbsp;hours.</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="${p.ink}" style="border-radius:6px;">
                      <a href="${esc(linkUrl)}" style="display:inline-block; background:${p.ink}; color:${p.paper}; text-decoration:none; padding:14px 32px; border-radius:6px; font-weight:600; font-size:15px;">Sign in</a>
                    </td>
                  </tr>
                </table>
                <p style="color:${p.muted}; font-size:13px; line-height:1.55; margin:28px 0 0;">If you didn't request this, you can ignore this email — no action is needed.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 32px;">
                <hr style="border:none; border-top:1px solid ${p.line}; margin:0 0 20px;" />
                <p style="color:${p.muted}; font-size:11px; line-height:1.5; margin:0; opacity:0.8;">A sign-in email sent by ${esc(host || name)} to ${esc(email)}. Access is limited to approved addresses.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { html, text, subject };
}
