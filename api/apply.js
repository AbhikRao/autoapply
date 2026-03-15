// api/apply.js — Vercel serverless function
// Receives a job URL + applicant profile, launches a TinyFish browser agent
// that navigates the real application form, fills it, and submits.
// Relays the live SSE event stream back to the browser.

const KEY = process.env.TINYFISH_API_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!KEY) return res.status(500).json({ error: 'TINYFISH_API_KEY not set' });

  const { jobUrl, profile } = req.body;
  if (!jobUrl) return res.status(400).json({ error: 'jobUrl required' });
  if (!profile?.name || !profile?.email) return res.status(400).json({ error: 'profile.name and profile.email required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');
  const goal = buildGoal(jobUrl, profile);

  try {
    emit({ type: 'LOG', message: 'Launching agent for: ' + jobUrl });

    const upstream = await fetch('https://agent.tinyfish.ai/v1/automation/run-sse', {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: jobUrl,
        goal,
        browser_profile: 'stealth',
      }),
    });

    if (!upstream.ok) {
      emit({ type: 'ERROR', message: `TinyFish ${upstream.status}: ${await upstream.text()}` });
      return res.end();
    }

    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

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
            case 'STARTED':       emit({ type: 'STARTED', runId: ev.runId }); break;
            case 'STREAMING_URL': emit({ type: 'STREAMING_URL', streamingUrl: ev.streamingUrl }); break;
            case 'PROGRESS':      emit({ type: 'PROGRESS', message: ev.purpose || ev.message || '' }); break;
            case 'HEARTBEAT':     emit({ type: 'HEARTBEAT' }); break;
            case 'COMPLETE':
              if (ev.status === 'COMPLETED') {
                let result = ev.resultJson;
                if (typeof result === 'string') {
                  try {
                    const clean = result.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
                    result = JSON.parse(clean);
                  } catch (_) {
                    result = { status: 'partial', notes: result, fieldsCompleted: 0 };
                  }
                }
                emit({ type: 'COMPLETE', result });
              } else {
                emit({ type: 'ERROR', message: ev.error?.message || `Run ended: ${ev.status}` });
              }
              break;
            default: emit(ev);
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') emit({ type: 'ERROR', message: err.message });
  } finally {
    res.end();
  }
}

function buildGoal(jobUrl, p) {
  const resumeInstruction = p.resumeUrl
    ? `RESUME UPLOAD — follow these steps exactly in order:
  a) Look for a resume/CV upload field on the form (it may say "Attach", "Upload", "Resume/CV").
  b) Click the "Attach" button or the file upload input directly.
  c) In the file dialog or URL input that appears, paste this direct PDF URL: ${p.resumeUrl}
  d) If the dialog has a URL input field, type the URL and confirm. If it opens a file picker, look for an option to paste or enter a URL.
  e) If none of the above works and there is a "Dropbox" or "Google Drive" option, skip those.
  f) If the ONLY option is "Enter manually", click it and paste just the resume URL: ${p.resumeUrl} — do NOT type out the applicant's profile details in this field.
  g) Do NOT type the applicant's name, education, skills, or any other profile information into the resume field. The resume field is ONLY for the file or URL.`
    : 'No resume URL provided — skip the resume upload field entirely if it is not required.';

  return `
You are an expert job application assistant. Your task is to complete a real job application on behalf of the applicant. Be precise and follow instructions exactly.

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
- Brief bio / summary: ${p.bio || 'not provided'}
- Cover letter preference: ${p.coverLetter || 'Keep it concise and professional. Emphasise relevant skills and enthusiasm for the role.'}

${resumeInstruction}

INSTRUCTIONS:
1. Navigate to the job URL. Read the full job description — note the role, required skills, and company name.
2. Find and click the Apply button. Follow any redirects to the ATS (Greenhouse, Lever, Workday, etc.).
3. Fill every visible form field using the applicant profile above.
4. For the resume/CV field, follow the RESUME UPLOAD steps above exactly — do not type profile text into it.
5. For custom screening questions, answer thoughtfully based on the job description and the applicant's profile. Keep answers concise (2-4 sentences).
6. For dropdowns (work authorisation, experience level, etc.), select the most appropriate option.
7. If the form has multiple pages, click Next / Continue after completing each page.
8. Review all fields before submitting.
9. Click the final Submit button and wait for the confirmation page.

Return a JSON object with this exact structure:
{
  "jobTitle": "<extracted job title>",
  "company": "<extracted company name>",
  "ats": "<detected ATS platform, e.g. Greenhouse / Lever / Workday / Direct>",
  "status": "submitted" | "error" | "partial",
  "confirmationText": "<text from the confirmation page, or null>",
  "questionsAnswered": [
    { "question": "<question text>", "answer": "<answer given>" }
  ],
  "fieldsCompleted": <number of fields successfully filled>,
  "notes": "<any issues encountered or observations>"
}
`.trim();
}
