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
                // resultJson may be a string — parse it so the frontend gets a real object
                let result = ev.resultJson;
                if (typeof result === 'string') {
                  try {
                    // Strip markdown code fences if present
                    const clean = result.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
                    result = JSON.parse(clean);
                  } catch (_) {
                    // If it won't parse, wrap it so the frontend still shows something
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
  const resumeNote = p.resumeUrl
    ? `The applicant's resume is hosted at: ${p.resumeUrl} — if asked to upload a resume, navigate to this URL first to download it, then upload it to the file input.`
    : 'No resume URL provided — skip file upload fields if they are not required.';

  return `
You are an expert job application assistant. Your task is to complete a real job application on behalf of the applicant. Be precise, thorough, and do not skip any required fields.

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

RESUME: ${resumeNote}

INSTRUCTIONS:
1. Navigate to the job URL. Read the full job description carefully — note the role, required skills, and company name.
2. Find the Apply button and click it. If it redirects to an external ATS (Greenhouse, Lever, Workday, etc.), follow it.
3. Fill in every visible form field using the applicant profile above.
4. For custom screening questions, answer thoughtfully based on the job description and the applicant's profile. Keep answers concise (2-4 sentences) and relevant.
5. For dropdown fields (work authorisation, experience level, etc.), select the most appropriate option.
6. If the form has multiple pages, click Next / Continue after completing each page.
7. Before submitting, review the form to ensure all required fields are filled.
8. Click the final Submit / Send Application button.
9. Wait for the confirmation page to load.

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
