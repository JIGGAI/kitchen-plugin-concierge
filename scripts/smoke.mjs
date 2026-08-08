import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const { streamChat } = await import(join(here, '..', 'dist', 'chat', 'stream.js'));
const { readCodexCredential } = await import(join(here, '..', 'dist', 'index.js'));

const cred = readCodexCredential();
if (!cred) {
  console.error('No OpenClaw OAuth credential found. Is OpenClaw configured on this machine?');
  process.exit(1);
}
console.log(`credential: plan=${cred.planType ?? 'unknown'} expires=${new Date(cred.expiresAt).toISOString()}`);

const slices = [{
  id: 'summary',
  label: 'Overview',
  href: '/',
  description: 'Org-wide revenue and appointment KPIs for the current month.',
  role: null,
  parameters: {},
  async read() {
    return 'Revenue MTD: $412,880. Appointments: 9,142. New clients: 611.';
  },
}, {
  id: 'payouts',
  label: 'Daily Payouts',
  href: '/daily-payouts',
  description: 'Per-stylist disbursement amounts for a given day.',
  role: 'payouts',
  parameters: {},
  async read() { return 'SHOULD NOT BE REACHED'; },
}];

const question = process.argv[2] ?? 'How is revenue tracking this month?';
const roles = process.argv[3] ? process.argv[3].split(',') : [];

console.log(`\nQ: ${question}`);
console.log(`roles: [${roles.join(', ')}]\n`);

const t0 = Date.now();
let first = null;
let firstEvent = null;

for await (const ev of streamChat({
  message: question,
  history: [],
  slices,
  user: { id: 'u1', email: 'rj@hairmx.net' },
  roles,
  scope: null,
  teamId: 'hmx-marketing-team',
})) {
  if (firstEvent === null) firstEvent = Date.now() - t0;
  if (ev.type === 'delta') {
    if (first === null) {
      first = Date.now() - t0;
      process.stdout.write(`[first token ${first}ms] `);
    }
    process.stdout.write(ev.text);
  } else {
    console.log('\n' + JSON.stringify(ev));
  }
}

const total = Date.now() - t0;
// first-feedback is what the user perceives: a `slice` event renders the
// "Reading X…" indicator before any prose arrives.
console.log(`\n--- first feedback: ${firstEvent}ms | first token: ${first ?? 'n/a'}ms | total: ${total}ms ---`);
if (firstEvent !== null && firstEvent > 4000) {
  console.error(`FAIL: first feedback ${firstEvent}ms exceeds the 4000ms gate`);
  process.exit(1);
}
