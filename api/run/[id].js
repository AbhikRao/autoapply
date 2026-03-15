// api/run/[id].js — Vercel serverless function
// Polls a TinyFish async run by ID (used for status checks).

const KEY = process.env.TINYFISH_API_KEY;

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'run id required' });
  const r = await fetch(`https://agent.tinyfish.ai/v1/runs/${id}`, {
    headers: { 'X-API-Key': KEY },
  });
  res.json(await r.json());
}
