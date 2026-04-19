// api/apply.js
export const config = { maxDuration: 300 };

const KEY           = process.env.TINYFISH_API_KEY;
const AXIOM_TOKEN   = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET || 'autoapply-runs';

function axiom(events) {
  if (!AXIOM_TOKEN) return;
  const payload = (Array.isArray(events) ? events : [events]).map(e => ({ ...e, _time: new Date().toISOString() }));
  fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/ingest`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${AXIOM_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!KEY) return res.status(500).json({ error: 'TINYFISH_API_KEY not set' });

  const { jobUrl, profile } = req.body;
  if (!jobUrl)                           return res.status(400).json({ error: 'jobUrl required' });
  if (!profile?.name || !profile?.email) return res.status(400).json({ error: 'profile.name and profile.email required' });

  const t0 = Date.now();
  const goal = buildGoal(jobUrl, profile);
  let runId = null;

  axiom({ event: 'run_start', jobUrl, applicantEmail: profile.email });

  let upstream;
  try {
    upstream = await fetch('https://agent.tinyfish.ai/v1/automation/run-sse', {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: jobUrl, goal, browser_profile: 'stealth' }),
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

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
              runId = ev.runId || ev.run_id || ev.id || 'started';
              emit(res, { type: 'STARTED', runId });
              axiom({ event: 'run_started', runId, jobUrl });
              break;
            case 'STREAMING_URL':
              emit(res, { type: 'STREAMING_URL', streamingUrl: ev.streamingUrl });
              break;
            case 'PROGRESS': {
              const msg = ev.purpose || ev.message || ev.text || ev.content || '';
              if (msg) emit(res, { type: 'PROGRESS', message: msg });
              break;
            }
            case 'HEARTBEAT':
              emit(res, { type: 'HEARTBEAT' });
              break;
            case 'COMPLETE': {
              // Accept resultJson OR result field
              let result = ev.resultJson ?? ev.result ?? null;
              if (typeof result === 'string') {
                try {
                  const clean = result.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
                  result = JSON.parse(clean);
                } catch (_) {
                  result = { status: 'partial', notes: result, fieldsFilled: [], fieldsSkipped: [], questionsAnswered: [], fieldsCompleted: 0 };
                }
              }
              // If agent completed but returned no JSON, build a useful fallback
              if (!result && ev.status === 'COMPLETED') {
                result = {
                  status: 'partial',
                  notes: 'Agent completed but returned no structured result. The application may have been submitted — check your email for a confirmation from the company.',
                  fieldsFilled: [],
                  fieldsSkipped: [],
                  questionsAnswered: [],
                  fieldsCompleted: 0,
                };
              }
              const durationMs = Date.now() - t0;
              if (ev.status !== 'COMPLETED') {
                const errMsg = ev.error?.message || ev.message || `Run ended: ${ev.status}`;
                emit(res, { type: 'ERROR', message: errMsg });
                axiom({ event: 'run_error', runId, jobUrl, error: errMsg, durationMs, phase: 'agent' });
              } else {
                emit(res, { type: 'COMPLETE', result });
                axiom({
                  event: 'run_complete', runId, jobUrl, durationMs,
                  status: result?.status || 'unknown',
                  jobTitle: result?.jobTitle || null,
                  company: result?.company || null,
                  ats: result?.ats || null,
                  fieldsCompleted: result?.fieldsCompleted || (Array.isArray(result?.fieldsFilled) ? result.fieldsFilled.length : 0),
                  questionsAnswered: Array.isArray(result?.questionsAnswered) ? result.questionsAnswered.length : 0,
                });
              }
              break;
            }
            case 'ERROR':
              emit(res, { type: 'ERROR', message: ev.message || ev.error || 'Unknown agent error' });
              axiom({ event: 'run_error', runId, jobUrl, error: ev.message, durationMs: Date.now() - t0, phase: 'stream' });
              break;
            default: {
              // Forward any text from unknown events as PROGRESS
              const unknownMsg = ev.message || ev.text || ev.purpose || ev.content || '';
              if (unknownMsg) emit(res, { type: 'PROGRESS', message: unknownMsg });
            }
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      emit(res, { type: 'ERROR', message: err.message });
      axiom({ event: 'run_error', runId, jobUrl, error: err.message, durationMs: Date.now() - t0, phase: 'read' });
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
    ? `RESUME UPLOAD:\n  a) Look for a resume/CV upload field on the application form.\n  b) If a text or URL input field exists, paste exactly this URL: ${p.resumeUrl}\n  c) If only a file picker button exists with no URL input, skip it and note "file upload requires local file" in fieldsSkipped.\n  d) NEVER paste the applicant name, bio, or skills into the resume field.`
    : 'RESUME: No resume URL provided. Skip any resume upload field and note it in fieldsSkipped.';

  return `You are an autonomous job application agent. Your ONLY goal is to COMPLETE AND SUBMIT a real online job application. Do NOT stop at the job description page. You MUST click Apply and fill the form.

TARGET JOB URL: ${jobUrl}

STEP 1 — FIND AND CLICK APPLY (this is mandatory):
- Navigate to the job URL.
- Find and click the primary Apply button. Look for: "Apply", "Apply Now", "Apply for this job", "Easy Apply", "Apply for this position", "Submit Application".
- If the page redirects to an ATS portal (Greenhouse, Lever, Workday, etc.), follow the redirect and continue.
- If a login or account creation wall appears, create a new account using the applicant's email address, then continue to the form.
- You MUST reach the actual application form. Simply reading the job description is NOT sufficient.

STEP 2 — FILL EVERY FIELD:
Applicant profile:
- Full name: ${p.name}
- Email: ${p.email}
- Phone: ${p.phone || 'not provided'}
- Location: ${p.location || 'not provided'}
- LinkedIn: ${p.linkedin || 'not provided'}
- GitHub / Portfolio: ${p.github || 'not provided'}
- Years of experience: ${p.experience || 'not provided'}
- Education: ${p.education || 'not provided'}
- Key skills: ${p.skills || 'not provided'}
- Bio / summary: ${p.bio || 'not provided'}
- Cover letter instructions: ${p.coverLetter || 'Concise, under 100 words. Professional tone. Highlight relevant experience and enthusiasm for the specific role.'}

${resumeInstruction}

Special field rules:
- EEO/diversity (race, gender, veteran, disability): select "Decline to self-identify" or equivalent opt-out.
- Salary/compensation: type "Negotiable" or leave blank if optional.
- "How did you hear about us?": select "Online job board" or "LinkedIn".
- Authorization checkboxes / consent: check all.
- Work authorization ("legally authorized to work?"): Yes.
- Sponsorship required now or in the future: No.
- Cover letter or personal statement fields: write one following the instructions above.
- Screening questions: answer thoughtfully in 2-4 sentences, tailored to the job description.
- CAPTCHA: note in fieldsSkipped as "CAPTCHA — requires human interaction".

STEP 3 — NAVIGATE AND SUBMIT:
- Click Next / Continue / Save on each page of multi-page forms.
- On the final page, click Submit / Submit Application.
- Wait for the confirmation page or success message.

Return ONLY this JSON object with no markdown fences, no extra text:
{
  "jobTitle": "<exact job title from the posting>",
  "company": "<company name>",
  "ats": "<Greenhouse|Lever|Workday|LinkedIn|iCIMS|Taleo|SmartRecruiters|Direct|Other>",
  "status": "<submitted|partial|error>",
  "confirmationText": "<exact confirmation message shown after submit, or null>",
  "fieldsFilled": [ { "field": "<field label>", "value": "<value you entered>" } ],
  "fieldsSkipped": [ { "field": "<field label>", "reason": "<why it was skipped>" } ],
  "questionsAnswered": [ { "question": "<question text>", "answer": "<answer you gave>" } ],
  "fieldsCompleted": <total integer count of fields filled>,
  "notes": "<any important observations, blockers, or issues encountered>"
}`.trim();
}
