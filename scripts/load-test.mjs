#!/usr/bin/env node
// Local load simulation: N students from ONE IP (like school Wi-Fi) each open the
// form, validate their class code, and submit — in waves, with duplicate retries.
//
//   BASE=http://localhost:8787 STUDENTS=300 CONCURRENCY=50 node scripts/load-test.mjs
//
// Requires a seeded local stack (npm run db:reset:local && npm run dev:api, or
// scripts/e2e-server.sh). Numbers measured here reflect the local Miniflare/D1
// runtime on this machine, NOT Cloudflare production performance.
const BASE = process.env.BASE ?? "http://localhost:8787";
const STUDENTS = Number(process.env.STUDENTS ?? 300);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const RETRY_RATE = Number(process.env.RETRY_RATE ?? 0.2); // fraction that "double-click"
const CODES = ["K7M4P", "H3QX9", "R8TZ2", "W5NB6", "D4JC7", "P2VY8", "M9GE3", "F6KS4", "T3HW5", "Y8DA2", "B7RQ6", "N4XU9"];
const origin = new URL(BASE).origin;

const lat = { form: [], code: [], submit: [] };
const status = {};
const note = (s) => (status[s] = (status[s] ?? 0) + 1);

async function timed(bucket, fn) {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    lat[bucket].push(performance.now() - t);
  }
}

const words = "thank you for the patience kindness encouragement jokes extra lessons and for believing in us every single day this year".split(" ");
function letter(seed) {
  let s = `Letter ${seed}: `;
  let i = seed;
  while (s.length < 160) s += words[(i = (i * 7 + 3) % words.length)] + " ";
  return s.trim();
}

async function student(i, form) {
  const cookie = `stjb_bid=load${i}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const headers = { "content-type": "application/json", origin, cookie };
  await timed("form", () => fetch(`${BASE}/api/public/form`).then((r) => r.json()));
  const code = CODES[i % CODES.length];
  const ca = await timed("code", () => fetch(`${BASE}/api/public/class-access`, { method: "POST", headers, body: JSON.stringify({ code }) }));
  note(`class-access ${ca.status}`);
  const t = form.teachers.map((x) => x.id);
  const off = i % t.length;
  const body = JSON.stringify({
    idempotencyKey: `load_${i}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    classCode: code,
    votes: form.awards.map((a, j) => ({ awardId: a.id, teacherId: t[(off + j) % t.length] })),
    notes: [0, 1, 2].map((j) => ({ teacherId: t[(off + 10 + j) % t.length], body: letter(i * 3 + j) })),
  });
  const send = () => timed("submit", () => fetch(`${BASE}/api/public/submissions`, { method: "POST", headers, body }));
  const tries = Math.random() < RETRY_RATE ? 3 : 1;
  const rs = await Promise.all(Array.from({ length: tries }, send));
  const receipts = new Set();
  for (const r of rs) {
    note(`submit ${r.status}`);
    if (r.ok) receipts.add((await r.json()).receiptCode);
  }
  return receipts.size;
}

const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(0) : "-";
};

const form = await (await fetch(`${BASE}/api/public/form`)).json();
const before = (await (await fetch(`${BASE}/api/admin/overview`, { headers: { "x-dev-user": "owner@example.com" } })).json()).submissions.total;
const t0 = performance.now();
let next = 0;
let distinctViolations = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < STUDENTS) {
      const i = next++;
      const n = await student(i, form).catch((e) => (note(`error ${e.message}`), 1));
      if (n > 1) distinctViolations++;
    }
  }),
);
const secs = (performance.now() - t0) / 1000;
const after = (await (await fetch(`${BASE}/api/admin/overview`, { headers: { "x-dev-user": "owner@example.com" } })).json()).submissions.total;

console.log(`\nStudents: ${STUDENTS}  concurrency: ${CONCURRENCY}  retry-burst rate: ${RETRY_RATE}  wall time: ${secs.toFixed(1)}s`);
console.log("Status counts:", status);
for (const k of Object.keys(lat)) console.log(`${k.padEnd(7)} n=${lat[k].length} p50=${pct(lat[k], 50)}ms p95=${pct(lat[k], 95)}ms max=${pct(lat[k], 100)}ms`);
console.log(`Submissions written: ${after - before} (expected ${STUDENTS})`);
console.log(`Students whose retries produced >1 distinct receipt: ${distinctViolations} (expected 0)`);
const ok = after - before === STUDENTS && distinctViolations === 0 && !Object.keys(status).some((k) => k.includes("429") || k.startsWith("error"));
console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
