// api/notify.js — Send run completion email via Resend
export const config = { maxDuration: 10 };

const RESEND_KEY = process.env.RESEND_API_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  // Silently no-op if key not configured
  if (!RESEND_KEY) return res.status(200).json({ ok: false, reason: 'no_key' });

  const { to, jobTitle, company, status, fieldsCompleted, questionsAnswered, duration, jobUrl, notes } = req.body;
  if (!to) return res.status(400).json({ error: 'to required' });

  const isSuccess = status === 'submitted';
  const subject = isSuccess
    ? `✓ Applied: ${jobTitle || 'Job'} at ${company || 'Company'} — AutoApply`
    : `⚠ ${jobTitle || 'Job'} at ${company || 'Company'} — ${status} — AutoApply`;

  const statusColor = isSuccess ? '#16a34a' : status === 'partial' ? '#d97706' : '#dc2626';
  const statusBg    = isSuccess ? 'rgba(22,163,74,.12)' : status === 'partial' ? 'rgba(217,119,6,.12)' : 'rgba(220,38,38,.12)';

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:32px;background:#0a0a0a;font-family:Inter,-apple-system,sans-serif;">
<div style="max-width:480px;margin:0 auto;background:#0d0d0d;border:1px solid #1f1f1f;border-radius:10px;overflow:hidden;">
  <div style="background:#000;padding:20px 24px;border-bottom:1px solid #1f1f1f;display:flex;align-items:center;gap:8px;">
    <span style="font-size:16px;font-weight:700;color:#f5f5f5;">AutoApply</span>
    <span style="font-size:12px;color:#717171;">&mdash; Application Result</span>
  </div>
  <div style="padding:24px;">
    <div style="font-size:20px;font-weight:600;color:#f5f5f5;margin-bottom:4px;">${jobTitle || 'Application'}</div>
    <div style="font-size:13px;color:#717171;margin-bottom:16px;">${company || ''}</div>
    <div style="display:inline-block;padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;background:${statusBg};color:${statusColor};border:1px solid ${statusColor}40;">${status}</div>
    <div style="margin-top:20px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
      <div style="background:#111;border:1px solid #1f1f1f;border-radius:8px;padding:12px;">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:#717171;margin-bottom:4px;">Fields</div>
        <div style="font-size:20px;font-weight:600;color:#f5f5f5;">${fieldsCompleted || 0}</div>
      </div>
      <div style="background:#111;border:1px solid #1f1f1f;border-radius:8px;padding:12px;">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:#717171;margin-bottom:4px;">Q&amp;A</div>
        <div style="font-size:20px;font-weight:600;color:#f5f5f5;">${questionsAnswered || 0}</div>
      </div>
      <div style="background:#111;border:1px solid #1f1f1f;border-radius:8px;padding:12px;">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:#717171;margin-bottom:4px;">Time</div>
        <div style="font-size:20px;font-weight:600;color:#f5f5f5;">${duration || 0}s</div>
      </div>
    </div>
    ${notes ? `<div style="margin-top:16px;padding:12px;background:#111;border:1px solid #1f1f1f;border-radius:8px;font-size:12px;color:#717171;line-height:1.6;">${notes}</div>` : ''}
    <div style="margin-top:16px;font-size:11px;color:#3d3d3d;word-break:break-all;font-family:monospace;">${jobUrl || ''}</div>
    <a href="${jobUrl || '#'}" style="display:inline-block;margin-top:16px;padding:8px 18px;background:#0070f3;border-radius:6px;color:#fff;font-size:12px;font-weight:600;text-decoration:none;">View Job Posting &rarr;</a>
  </div>
  <div style="padding:12px 24px;border-top:1px solid #1f1f1f;font-size:11px;color:#3d3d3d;">Sent by AutoApply &mdash; autoapply-omega.vercel.app</div>
</div>
</body></html>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'AutoApply <onboarding@resend.dev>',
        to: [to],
        subject,
        html,
      }),
    });
    const data = await r.json();
    return res.status(200).json({ ok: r.ok, data });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}
