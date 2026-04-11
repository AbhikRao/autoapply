// api/apply.js
// Proxies the full TinyFish SSE stream to the browser.
// Vercel maxDuration is 300s — enough for any real run.

export const config = { maxDuration: 300 };

const KEY           = process.env.TINYFISH_API_KEY;
const AXIOM_TOKEN   = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET || 'autoapply-runs';

/* Fire-and-forget Axiom ingest — never blocks the main stream */
function axiom(events) {
  if (!AXIOM_TOKEN) return;
  const payload = (Array.isArray(events) ? events : [events]).map(e => ({
    ...e,
    _time: new Date().toISOString(),
  }));
  fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/ingest`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${AXIOM_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch(() => {}); // silent failure — never break the user flow
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!KEY) return res.status(500).json({ error: 'TINYFISH_API_KEY not set' });

  const { jobUrl, profile } = req.body;
  if (!jobUrl)                           return res.status(400).json({ error: 'jobUrl required' });
  if (!profile?.name || !profile?.email) return res.status(400).json({ error: 'profile.name and profile.email required' });

  const t0   = Date.now();
  const goal = buildGoal(jobUrl, profile);
  let   runId = null;

  axiom({ event: 'run_start', jobUrl, applicantEmail: profile.email });

  let upstream;
  try {
    upstream = await fetch('https://agent.tinyfish.ai/v1/automation/run-sse', {
      method:  'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: jobUrl, goal, browser_profile: 'stealth' }),
    });
  } catch (err) {
    axiom({ event: 'run_error', jobUrl, error: err.message, phase: 'connect' });
    return res.status(502).json({ error: 'Cannot reach TinyFish: ' + err.message });
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    axiom({ event: 'run_error', jobUrl, error: `TinyFish ${upstream.status}`, phase: 'upstream' });
    return res.status(502).json({ error: `TinyFish ${upstream.status}: ${txt}` });
  }

  // SSE headers
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const reader = upstream.body.getReader();
  const dec    = new TextDecoder();
  let   buf    = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6).trim());

          switch (ev.type) {
            case 'STARTED':
              runId = ev.runId;
              emit(res, { type: 'STARTED', runId });
              axiom({ event: 'run_started', runId, jobUrl });
              break;

            case 'STREAMING_URL':
              emit(res, { type: 'STREAMING_URL', streamingUrl: ev.streamingUrl });
              break;

            case 'PROGRESS':
              emit(res, { type: 'PROGRESS', message: ev.purpose || ev.message || '' });
              break;

            case 'HEARTBEAT':
              emit(res, { type: 'HEARTBEAT' });
              break;

            case 'COMPLETE': {
              let result = ev.resultJson ?? null;
              if (typeof result === 'string') {
                try {
                  const clean = result
                    .replace(/^```(?:json)?\s*/i, '')
                    .replace(/\s*```\s*$/i,       '')
                    .trim();
                  result = JSON.parse(clean);
                } catch (_) {
                  result = { status: 'partial', notes: result, fieldsFilled: [], fieldsSkipped: [], questionsAnswered: [], fieldsCompleted: 0 };
                }
              }
              const durationMs = Date.now() - t0;
              if (ev.status !== 'COMPLETED') {
                const errMsg = ev.error?.message || `Run ended: ${ev.status}`;
                emit(res, { type: 'ERROR', message: errMsg });
                axiom({ event: 'run_error', runId, jobUrl, error: errMsg, durationMs, phase: 'agent' });
              } else {
                emit(res, { type: 'COMPLETE', result });
                axiom({
                  event:            'run_complete',
                  runId,
                  jobUrl,
                  durationMs,
                  status:           result?.status          || 'unknown',
                  jobTitle:         result?.jobTitle        || null,
                  company:          result?.company         || null,
                  ats:              result?.ats             || null,
                  fieldsCompleted:  result?.fieldsCompleted || (Array.isArray(result?.fieldsFilled) ? result.fieldsFilled.length : 0),
                  questionsAnswered: Array.isArray(result?.questionsAnswered) ? result.questionsAnswered.length : 0,
                });
              }
              break;
            }

            case 'ERROR':
              emit(res, { type: 'ERROR', message: ev.message || 'Unknown agent error' });
              axiom({ event: 'run_error', runId, jobUrl, error: ev.message, durationMs: Date.now()-t0, phase: 'stream' });
              break;

            default:
              emit(res, ev);
          }
        } catch (_) { /* skip malformed lines */ }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      emit(res, { type: 'ERROR', message: err.message });
      axiom({ event: 'run_error', runId, jobUrl, error: err.message, durationMs: Date.now()-t0, phase: 'read' });
    }
  } finally {
    res.end();
  }
}

function emit(res, data) {
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

function buildGoal(jobUrl, p) {
  const resumeInstruction = p.resumeUrl
    ? `RESUME UPLOAD — for the resume/CV field:\n  a) Click Attach/Upload.\n  b) If a URL input is shown, paste: ${p.resumeUrl}\n  c) If only "Enter manually" exists, paste ONLY this URL: ${p.resumeUrl} — do NOT type the applicant profile.\n  d) Do NOT write the applicant's name, skills, bio, or any other text into the resume field.`
    : 'RESUME: No resume URL provided — skip the file upload field if not required.';

  return `You are an expert job application assistant. Complete a real online job application on behalf of the applicant. Be precise and thorough.

TARGET JOB URL: ${jobUrl}

APPLICANT PROFILE:
- Full name: ${p.name}
- Email: ${p.email}
- Phone: ${p.phone || 'not provided'}
- Location: ${p.location || 'not provided'}
- LinkedIn: ${p.linkedin || 'not provided'}
- GitHub / Portfolio: ${p.github || 'not provided'}
- Years of experience: ${p.experience || 'not provided'}
- Education: ${p.education || 'not provided'}
- Key skills: ${p.skills || 'not provided'}
- Brief bio: ${p.bio || 'not provided'}
- Cover letter style: ${p.coverLetter || 'Concise, professional, highlight relevant skills.'}

${resumeInstruction}

INSTRUCTIONS:
1. Navigate to the job URL. Read the full job description.
2. Click Apply and follow any ATS redirects.
3. Fill every field using the applicant profile.
4. Answer screening questions thoughtfully (2-4 sentences each).
5. Select best-match options for any dropdowns.
6. Navigate multi-page forms, click Next/Continue as needed.
7. Submit and wait for the confirmation page.

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "jobTitle": "<exact job title>",
  "company": "<company name>",
  "ats": "<Greenhouse|Lever|Workday|LinkedIn|Direct|Other>",
  "status": "<submitted|partial|error>",
  "confirmationText": "<confirmation message or null>",
  "fieldsFilled": [ { "field": "<label>", "value": "<value entered>" } ],
  "fieldsSkipped": [ { "field": "<label>", "reason": "<why>" } ],
  "questionsAnswered": [ { "question": "<text>", "answer": "<answer>" } ],
  "fieldsCompleted": <integer>,
  "notes": "<observations or issues>"
}`.trim();
}
