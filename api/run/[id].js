// api/run/[id].js — poll a TinyFish run by ID
const KEY = process.env.TINYFISH_API_KEY;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!KEY) return res.status(500).json({ error: 'TINYFISH_API_KEY not set' });

  // id comes from query string (injected by vercel.json route: ?id=$1)
  // fall back to parsing the URL path directly if query is missing
  const id = req.query.id ||
    (req.url || '').replace(/^.*\/api\/run\//, '').split('?')[0];

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
  if (data.status) data.status = data.status.toUpperCase();

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

  if (['FAILED', 'ERROR', 'CANCELLED'].includes(data.status) && !data.result) {
    data.result = {
      status: 'error',
      notes: data.error?.message || data.errorMessage || `Run ended: ${data.status}`,
      fieldsFilled: [],
      fieldsSkipped: [],
      questionsAnswered: [],
      fieldsCompleted: 0,
    };
  }

  return res.json(data);
}
