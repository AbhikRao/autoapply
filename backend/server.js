// backend/server.js
// Local dev server — mirrors the Vercel api/ functions exactly.
// Run with `npm start`, then open http://localhost:3001

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app  = express();
const KEY  = process.env.TINYFISH_API_KEY;

if (!KEY) { console.error('\n  ERROR: Missing TINYFISH_API_KEY in .env\n'); process.exit(1); }

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// ─── POST /api/apply ────────────────────────────────────────────────────────
// Starts TinyFish run, reads until runId + streamingUrl, returns JSON.
app.post('/api/apply', async (req, res) => {
  const { jobUrl, profile } = req.body;
  if (!jobUrl) return res.status(400).json({ error: 'jobUrl required' });
  if (!profile?.name || !profile?.email)
    return res.status(400).json({ error: 'profile.name and profile.email required' });

  const goal = buildGoal(jobUrl, profile);

  let upstream;
  try {
    upstream = await fetch('https://agent.tinyfish.ai/v1/automation/run-sse', {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: jobUrl, goal, browser_profile: 'stealth' }),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach TinyFish: ' + err.message });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return res.status(502).json({ error: `TinyFish ${upstream.status}: ${text}` });
  }

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '', runId = null, streamingUrl = null, agentError = null;

  try {
    const deadline = Date.now() + 20000;
    outer: while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6).trim());
          if (ev.type === 'STARTED')       runId = ev.runId;
          if (ev.type === 'STREAMING_URL') streamingUrl = ev.streamingUrl;
          if (ev.type === 'ERROR')         { agentError = ev.message; break outer; }
          if (ev.type === 'COMPLETE')      break outer;
          if (runId && streamingUrl)       break outer;
        } catch (_) {}
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (agentError) return res.status(502).json({ error: agentError });
  if (!runId)     return res.status(502).json({ error: 'Agent did not return a run ID.' });

  res.json({ runId, streamingUrl });
});

// ─── GET /api/run/:id ────────────────────────────────────────────────────────
// Polls TinyFish run status. Returns status + parsed result.
app.get('/api/run/:id', async (req, res) => {
  const { id } = req.params;
  let r;
  try {
    r = await fetch(`https://agent.tinyfish.ai/v1/runs/${id}`, {
      headers: { 'X-API-Key': KEY },
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach TinyFish: ' + err.message });
  }

  if (!r.ok) return res.status(r.status).json({ error: `TinyFish ${r.status}` });

  const data = await r.json();
  if (data.status) data.status = data.status.toUpperCase();

  if (data.resultJson != null) {
    if (typeof data.resultJson === 'string') {
      try {
        const clean = data.resultJson
          .replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        data.result = JSON.parse(clean);
      } catch (_) {
        data.result = { status: 'partial', notes: data.resultJson, fieldsFilled: [], fieldsSkipped: [], questionsAnswered: [], fieldsCompleted: 0 };
      }
    } else {
      data.result = data.resultJson;
    }
  }

  if (!data.result && (data.status === 'FAILED' || data.status === 'ERROR' || data.status === 'CANCELLED')) {
    data.result = { status: 'error', notes: data.error?.message || `Run ended: ${data.status}`, fieldsFilled: [], fieldsSkipped: [], questionsAnswered: [], fieldsCompleted: 0 };
  }

  res.json(data);
});

function buildGoal(jobUrl, p) {
  const resumeInstruction = p.resumeUrl
    ? `RESUME UPLOAD — for the resume/CV field:\n  a) Click Attach/Upload.\n  b) If a URL input is shown, paste: ${p.resumeUrl}\n  c) If only "Enter manually" exists, paste ONLY this URL: ${p.resumeUrl} — do NOT type the applicant profile in this field.`
    : 'RESUME: No resume URL provided — skip the file upload field if not required.';

  return `You are an expert job application assistant. Complete a real online job application on behalf of the applicant below.

TARGET JOB URL: ${jobUrl}

APPLICANT PROFILE:
- Full name: ${p.name}
- Email: ${p.email}
- Phone: ${p.phone || 'not provided'}
- Location: ${p.location || 'not provided'}
- LinkedIn: ${p.linkedin || 'not provided'}
- GitHub: ${p.github || 'not provided'}
- Experience: ${p.experience || 'not provided'}
- Education: ${p.education || 'not provided'}
- Skills: ${p.skills || 'not provided'}
- Bio: ${p.bio || 'not provided'}
- Cover letter style: ${p.coverLetter || 'Concise, professional, highlight relevant skills.'}

${resumeInstruction}

INSTRUCTIONS:
1. Navigate to the job URL. Read the full job description.
2. Click Apply. Follow redirects to the ATS.
3. Fill every field using the profile above.
4. Answer screening questions thoughtfully (2-4 sentences, tailored to the JD).
5. For dropdowns: select the best match.
6. For multi-page forms: click Next/Continue after each page.
7. Submit. Wait for confirmation page.

Return ONLY valid JSON (no markdown fences, no extra text):
{
  "jobTitle": "<exact job title>",
  "company": "<company name>",
  "ats": "<Greenhouse|Lever|Workday|LinkedIn|Direct|Other>",
  "status": "<submitted|partial|error>",
  "confirmationText": "<confirmation message after submit, or null>",
  "fieldsFilled": [ { "field": "<label>", "value": "<value entered>" } ],
  "fieldsSkipped": [ { "field": "<label>", "reason": "<why skipped>" } ],
  "questionsAnswered": [ { "question": "<question>", "answer": "<answer>" } ],
  "fieldsCompleted": <integer>,
  "notes": "<observations and issues>"
}`.trim();
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`\n  AutoApply  →  http://localhost:${PORT}\n`));
