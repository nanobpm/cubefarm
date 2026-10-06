#!/usr/bin/env node
// A fake nano-workforce app (its /app/api surface, the parts cubefarm's nano mode uses) for trying nano mode with
// the demo office: four workers picking up jobs on demo-co repos, an escalation now and then, terminal output.
//   node scripts/fake-nano.mjs [port]          (default 4398)
//   SWARM_HOME=$PWD/.swarm-home SWARM_PORT=<port> node --import tsx server/index.ts --demo --nano http://localhost:4398
import http from 'node:http';

const port = Number(process.argv[2] ?? 4398);
const repos = ['demo-co/pixel-todo', 'demo-co/weather-api'];
const steps = [
  ['plan-fanout', 'plan'],
  ['plan-fanout', 'implement-task'],
  ['convergence-loop', 'review-round'],
  ['merge-loop', 'fix-ci'],
];
const workers = ['copilot-1', 'copilot-2', 'claude-1', 'kimi-1'].map((name, i) => ({ instance: `w${i + 1}`, identity: `fleet/${name}`, job: null }));
let seq = 1;
const streams = new Map(); // stream -> { entries, status }
const escalations = [];
const prs = new Map(); // key -> pr
const handed = [];

function tick() {
  for (const w of workers) {
    if (w.job && Math.random() < 0.15) {
      streams.get(w.job.stream).status = 'completed';
      w.job = null;
      continue;
    }
    if (!w.job && Math.random() < 0.3) {
      const [proc, el] = steps[Math.floor(Math.random() * steps.length)];
      const repo = repos[Math.floor(Math.random() * repos.length)];
      const issue = handed.shift() ?? { repo, number: 1 + Math.floor(Math.random() * 6) };
      const jobKey = String(2251799813600000 + seq++);
      const reviewing = proc !== 'plan-fanout';
      const number = reviewing ? 100 + Math.floor(Math.random() * 5) : issue.number;
      w.job = { jobKey, stream: `job:${jobKey}`, bpmnProcessId: proc, elementId: el, planKey: `${issue.repo}#${number}` };
      streams.set(w.job.stream, { entries: [], status: 'open', offset: 0 });
      if (reviewing) prs.set(`${issue.repo}#${number}`, { prKey: `${issue.repo}#${number}`, repo: issue.repo, number, url: `https://github.com/${issue.repo}/pull/${number}`, title: `Fake PR ${number}`, status: el, round: 1 + Math.floor(Math.random() * 4), processKey: null, waitingSince: null, openEscalation: null, updatedAt: new Date().toISOString(), activeWorker: w.instance, leaseUntil: null });
    }
    if (w.job) {
      const s = streams.get(w.job.stream);
      s.entries.push({ offset: s.offset++, chunk: `\u001b[36m${w.identity}\u001b[0m ${w.job.elementId}: step ${s.offset} on ${w.job.planKey}\r\n` });
    }
  }
  if (escalations.length < 2 && Math.random() < 0.05) {
    const repo = repos[0];
    escalations.push({ userTaskKey: String(2251799813700000 + seq++), kind: 'plan-review', kindLabel: 'Plan review', prKey: null, subjectType: 'plan', subjectKey: `${repo}#3`, subjectTitle: 'Plan for #3', subjectUrl: `https://github.com/${repo}/issues/3`, question: 'The planner split #3 into 3 tasks. Proceed?', formKey: 'plan-review-decision', processKey: null, formVariables: {} });
  }
}
setInterval(tick, 2000);

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const read = (req) => new Promise((ok) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => ok(b ? JSON.parse(b) : {}));
});

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname.replace(/^\/app\/api/, '');
    if (req.method === 'GET' && p === '/agentic/supply') {
      return json(res, 200, {
        count: workers.length,
        workers: workers.map((w) => ({ instance: w.instance, identity: w.identity, stream: w.instance, family: 'senior', host: 'fake', jobKeys: w.job ? [w.job.jobKey] : [], live: true, staleMs: 0, harnessStale: false })),
        leaves: [],
        correlations: workers.filter((w) => w.job).map((w) => w.job),
      });
    }
    if (req.method === 'GET' && p === '/agent/skill') {
      const skill = '---\nname: nano-workforce\ndescription: Drive the fake nano-workforce.\n---\n\n# Fake nano-workforce\n\nGET /status lists PRs in flight; POST /actions/start/plan-fanout {issue, baseBranch} starts an issue.\n';
      return json(res, 200, { format: 'markdown', appVersion: 'fake', baseUrl: `http://${req.headers.host}/app/api`, skill });
    }
    if (req.method === 'GET' && p === '/status') return json(res, 200, { count: prs.size, prs: [...prs.values()] });
    if (req.method === 'GET' && p === '/escalations') return json(res, 200, { count: escalations.length, escalations });
    if (req.method === 'GET' && p === '/agentic/transcripts') {
      const s = streams.get(u.searchParams.get('stream'));
      if (!s) return json(res, 404, { error: 'no such stream' });
      const from = Number(u.searchParams.get('from') ?? 0);
      return json(res, 200, { stream: u.searchParams.get('stream'), status: s.status, nextOffset: s.offset, entries: s.entries.filter((e) => e.offset >= from) });
    }
    if (req.method === 'POST' && p === '/actions/start/plan-fanout') {
      const body = await read(req);
      const [repo, n] = String(body.issue).split('#');
      handed.push({ repo, number: Number(n) });
      console.log('plan-fanout', body);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/actions/complete-user-task') {
      const body = await read(req);
      const i = escalations.findIndex((e) => e.userTaskKey === body.userTaskKey);
      if (i < 0) return json(res, 404, { error: 'no such task' });
      escalations.splice(i, 1);
      console.log('complete-user-task', body);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: `fake nano: no ${req.method} ${p}` });
  })
  .listen(port, () => console.log(`fake nano-workforce on http://localhost:${port}`));
