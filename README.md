# AutoApply

Autonomous job application agent built on the [TinyFish Web Agent API](https://tinyfish.ai).

You provide a job URL and your profile. A TinyFish browser agent navigates to the real application form, reads the job description, fills every field intelligently, uploads your resume, and submits — while you watch it work live.

Works on Greenhouse, Lever, Workday, LinkedIn Easy Apply, and direct company career pages.

**Live demo:** [autoapply.vercel.app](https://autoapply.vercel.app)

---

## Why this requires a web agent

- Application forms have no public API
- Every ATS platform has a different form structure — fields must be discovered at runtime
- Resume upload requires interacting with a real `<input type="file">` element
- Multi-page forms require navigation (Next / Continue / Submit buttons)
- Custom screening questions vary per job and must be answered intelligently
- Job descriptions must be read to tailor answers

None of this is possible without a real browser agent.

---

## What it does

1. Navigates to the job URL and reads the full job description
2. Detects the ATS platform (Greenhouse, Lever, Workday, etc.)
3. Fills basic fields: name, email, phone, LinkedIn, GitHub, location
4. Fills work experience and education fields
5. Answers custom screening questions based on the job description and your profile
6. Uploads your resume to the file input
7. Navigates multi-page forms (clicks Next, handles pagination)
8. Submits the application
9. Returns: confirmation, all questions asked, all answers given, time taken

---

## Running locally

```bash
git clone https://github.com/AbhikRao/autoapply
cd autoapply
npm install
cp .env.example .env   # add TINYFISH_API_KEY
npm start              # backend on :3001
open public/index.html
```

Get a free API key at [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys).

---

## Architecture

```
public/index.html      Static frontend — profile form + live browser preview
api/apply.js           Vercel serverless — TinyFish SSE relay
api/run/[id].js        Vercel serverless — poll async run status
backend/server.js      Local dev server (mirrors api/ functions)
vercel.json            Routing + function config
```

---

## Stack

- **Frontend:** Vanilla HTML/CSS/JS — no framework, no build step
- **Backend:** Node.js serverless functions (Vercel)
- **Web automation:** TinyFish Web Agent `/run-sse`
