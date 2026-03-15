// api/apply.js — Vercel serverless function
// Starts a TinyFish run and returns {runId, streamingUrl} immediately.
// Does NOT relay the full SSE stream — that would hit Vercel's 60s timeout.
// The frontend polls /api/run/[id] until the agent finishes.

const KEY = process.env.TINYFISH_API_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!KEY) return res.status(500).json({ error: 'TINYFISH_API_KEY not set' });

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

  // Read SSE events only until we have runId + streamingUrl (arrives in ~2-3s).
  // Then close the upstream stream — the agent keeps running on TinyFish servers.
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '', runId = null, streamingUrl = null, agentError = null;

  try {
    const deadline = Date.now() + 20000; // 20s max to get startup events
    outer: while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6).trim());
          if (ev.type === 'STARTED')        runId = ev.runId;
          if (ev.type === 'STREAMING_URL')  streamingUrl = ev.streamingUrl;
          if (ev.type === 'ERROR')          { agentError = ev.message; break outer; }
          if (ev.type === 'COMPLETE')       break outer; // very fast run
          if (runId && streamingUrl)        break outer;
        } catch (_) {}
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (agentError) return res.status(502).json({ error: agentError });
  if (!runId)     return res.status(502).json({ error: 'Agent did not return a run ID. TinyFish may be down or the key is invalid.' });

  return res.json({ runId, streamingUrl });
}

function buildGoal(jobUrl, p) {
  const resumeInstruction = p.resumeUrl
    ? `RESUME UPLOAD — for the resume/CV field:\n  a) Click Attach/Upload.\n  b) If a URL input is shown, paste: ${p.resumeUrl}\n  c) If only "Enter manually" exists, paste ONLY this URL: ${p.resumeUrl} — do NOT type the applicant profile in this field.\n  d) Do NOT write the applicant's name, skills, or bio into the resume field.`
    : 'RESUME: No resume URL provided — skip the file upload field if not required.';

  return `You are an expert job application assistant. Complete a real online job application on behalf of the applicant below. Be precise and thorough.

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
- Cover letter style: ${p.coverLetter || 'Keep it concise and professional. Highlight relevant skills and enthusiasm for the role.'}

${resumeInstruction}

INSTRUCTIONS:
1. Navigate to the job URL. Read the full job description — note the role, company, required skills.
2. Find and click the Apply button. Follow any redirects to the ATS.
3. Fill every visible field using the applicant profile above.
4. For screening questions: answer thoughtfully (2-4 sentences, tailored to the job description).
5. For dropdowns (work authorisation, experience level, etc.): select the best match.
6. For multi-page forms: click Next/Continue after each page.
7. Submit the application. Wait for the confirmation page to load.

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "jobTitle": "<exact job title from the page>",
  "company": "<company name>",
  "ats": "<Greenhouse|Lever|Workday|LinkedIn|Direct|Other>",
  "status": "<submitted|partial|error>",
  "confirmationText": "<verbatim confirmation message shown after submit, or null>",
  "fieldsFilled": [
    { "field": "<field label>", "value": "<value you entered>" }
  ],
  "fieldsSkipped": [
    { "field": "<field label>", "reason": "<why it was skipped or could not be filled>" }
  ],
  "questionsAnswered": [
    { "question": "<question text>", "answer": "<answer you gave>" }
  ],
  "fieldsCompleted": <integer count of fieldsFilled>,
  "notes": "<any observations, issues encountered, or additional context>"
}`.trim();
}
