// api/run/[id].js — Vercel serverless function
// Polls a TinyFish run by ID. Returns status + parsed result object.

const KEY = process.env.TINYFISH_API_KEY;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!KEY) return res.status(500).json({ error: 'TINYFISH_API_KEY not set' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'run id required' });

  let r;
  try {
    r = await fetch(`https://agent.tinyfish.ai/v1/automation/runs/${id}`, {
      headers: { 'X-API-Key': KEY },
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach TinyFish: ' + err.message });
  }

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return res.status(r.status).json({ error: `TinyFish ${r.status}: ${body}` });
  }

  const data = await r.json();

  // Normalise status to uppercase
  if (data.status) data.status = data.status.toUpperCase();

  // Parse resultJson into a proper object if present
  if (data.resultJson != null) {
    if (typeof data.resultJson === 'string') {
      try {
        const clean = data.resultJson
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/i, '')
          .trim();
        data.result = JSON.parse(clean);
      } catch (_) {
        data.result = {
          status: 'partial',
          notes: data.resultJson,
          fieldsFilled: [],
          fieldsSkipped: [],
          questionsAnswered: [],
          fieldsCompleted: 0,
        };
      }
    } else if (typeof data.resultJson === 'object') {
      data.result = data.resultJson;
    }
  }

  // Surface error info cleanly for terminal states
  if (['FAILED', 'ERROR', 'CANCELLED'].includes(data.status)) {
    if (!data.result) {
      data.result = {
        status: 'error',
        notes: data.error?.message || data.errorMessage || `Run ended with status: ${data.status}`,
        fieldsFilled: [],
        fieldsSkipped: [],
        questionsAnswered: [],
        fieldsCompleted: 0,
      };
    }
  }

  return res.json(data);
}
