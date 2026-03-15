// backend/server.js
// Local dev server — mirrors the Vercel api/ functions exactly.
// Run with `npm start`, open public/index.html in your browser.

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const KEY = process.env.TINYFISH_API_KEY;

if (!KEY) { console.error('Missing TINYFISH_API_KEY in .env'); process.exit(1); }

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const emit = (res, data) => res.write('data: ' + JSON.stringify(data) + '\n\n');

function buildGoal(jobUrl, p) {
  const resumeNote = p.resumeUrl
    ? `Resume hosted at: ${p.resumeUrl} — navigate there to download, then upload to the file input.`
    : 'No resume URL provided — skip optional file upload fields.';

  return `You are an expert job application assistant. Complete a real job application on behalf of the applicant.

TARGET URL: ${jobUrl}

APPLICANT:
Name: ${p.name} | Email: ${p.email} | Phone: ${p.phone || 'N/A'}
Location: ${p.location || 'N/A'} | LinkedIn: ${p.linkedin || 'N/A'} | GitHub: ${p.github || 'N/A'}
Experience: ${p.experience || 'N/A'} | Education: ${p.education || 'N/A'}
Skills: ${p.skills || 'N/A'}
Bio: ${p.bio || 'N/A'}
Cover letter: ${p.coverLetter || 'Concise and professional. Highlight relevant skills and enthusiasm.'}
${resumeNote}

STEPS:
1. Load the URL. Read the job description (role, company, required skills).
2. Find and click Apply / Apply Now.
3. Fill every field using the profile above.
4. Answer custom screening questions thoughtfully (2-4 sentences, tailored to the JD).
5. For dropdowns (work auth, experience level) pick the best option.
6. Navigate multi-page forms by clicking Next / Continue.
7. Submit the application.
8. Wait for the confirmation page.

Return ONLY JSON:
{
  "jobTitle": "",
  "company": "",
  "ats": "Greenhouse|Lever|Workday|LinkedIn|Direct",
  "status": "submitted|error|partial",
  "confirmationText": null,
  "questionsAnswered": [{ "question": "", "answer": "" }],
  "fieldsCompleted": 0,
  "notes": ""
}`.trim();
}

app.post('/api/apply', async (req, res) => {
  const { jobUrl, profile } = req.body;
  if (!jobUrl) return res.status(400).json({ error: 'jobUrl required' });
  if (!profile?.name || !profile?.email) return res.status(400).json({ error: 'profile.name and profile.email required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    emit(res, { type: 'LOG', message: 'Launching agent for: ' + jobUrl });

    const upstream = await fetch('https://agent.tinyfish.ai/v1/automation/run-sse', {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: jobUrl, goal: buildGoal(jobUrl, profile), browser_profile: 'stealth' }),
    });

    if (!upstream.ok) {
      emit(res, { type: 'ERROR', message: `TinyFish ${upstream.status}: ${await upstream.text()}` });
      return res.end();
    }

    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6).trim());
          switch (ev.type) {
            case 'STARTED':       emit(res, { type: 'STARTED', runId: ev.runId }); break;
            case 'STREAMING_URL': emit(res, { type: 'STREAMING_URL', streamingUrl: ev.streamingUrl }); break;
            case 'PROGRESS':      emit(res, { type: 'PROGRESS', message: ev.purpose || ev.message || '' }); break;
            case 'HEARTBEAT':     emit(res, { type: 'HEARTBEAT' }); break;
            case 'COMPLETE':
              ev.status === 'COMPLETED'
                ? emit(res, { type: 'COMPLETE', result: ev.resultJson })
                : emit(res, { type: 'ERROR', message: ev.error?.message || `Run ${ev.status}` });
              break;
            default: emit(res, ev);
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') emit(res, { type: 'ERROR', message: err.message });
  } finally { res.end(); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`\n  AutoApply  →  http://localhost:${PORT}\n`));
