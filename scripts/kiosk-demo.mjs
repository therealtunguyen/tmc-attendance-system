// Development-only demo: temporary data, mock TCS, no production deployment.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import { createApp } from '../apps/edge/src/app.ts';
import { openDb } from '../apps/edge/src/db.ts';
import { SnapshotManager } from '../apps/edge/src/snapshot.ts';
import { ServerClient } from '../apps/edge/src/server-client.ts';
import { MockTurnstile } from '../apps/server/src/adapters/tcs/mock.ts';
import { signQrToken } from '../apps/server/src/shared/contracts/qr-token.ts';
import { InMemoryUsers } from '../apps/server/src/modules/iam/iam.fakes.ts';
import { IamService } from '../apps/server/src/modules/iam/iam.service.ts';
import { hashPassword } from '../apps/server/src/modules/iam/iam.auth.ts';
import { authenticate, iamRoutes } from '../apps/server/src/modules/iam/iam.routes.ts';
import { requirePermission } from '../apps/server/src/modules/iam/iam.rbac.ts';
import { chainHash, GENESIS_HASH } from '../apps/server/src/modules/iam/iam.audit-chain.ts';
import {
  EmployeeQrService,
  QrNotIssuableError,
} from '../apps/server/src/modules/employee-qr/employee-qr.service.ts';

const fetch = globalThis.fetch;
const host = process.env.DEMO_HOST || '127.0.0.1';
const phoneAddress = Object.entries(networkInterfaces())
  .flatMap(([name, addresses]) => (addresses ?? []).map((address) => ({ name, ...address })))
  .filter(
    (address) => address.family === 'IPv4' && !address.internal && !address.name.startsWith('utun'),
  )
  .sort((a, b) => Number(b.name === 'en0') - Number(a.name === 'en0'))[0]?.address;

class DemoUsers extends InMemoryUsers {
  rows = [];
  async append(entry) {
    const prevHash = this.rows.at(-1)?.hash ?? GENESIS_HASH;
    this.rows.push({
      ...entry,
      seq: this.rows.length + 1,
      prevHash,
      hash: chainHash(prevHash, entry),
    });
  }
  async search() {
    return [...this.rows].reverse();
  }
  async chain() {
    return this.rows;
  }
}
const users = new DemoUsers();
await users.createUser({
  username: 'an.demo',
  passwordHash: await hashPassword('DemoEmployee123!'),
  role: 'EMP',
  employeeId: 'demo-active',
});
const iam = new IamService(users);

const { privateKey } = generateKeyPairSync('ed25519');
const employees = [
  {
    id: 'demo-active',
    firstName: 'An',
    lastName: 'Nguyễn (demo)',
    code: 'DEMO001',
    email: 'an@example.test',
    factoryId: 'demo-factory',
    teamId: null,
    active: true,
    qrRevoked: false,
  },
  {
    id: 'demo-revoked',
    firstName: 'Lan',
    lastName: 'Trần (demo)',
    code: 'DEMO002',
    email: 'lan@example.test',
    factoryId: 'demo-factory',
    teamId: null,
    active: true,
    qrRevoked: true,
  },
];
const employeeQr = new EmployeeQrService(
  {
    find: async (id) => employees.find((employee) => employee.id === id) ?? null,
    list: async () => employees,
  },
  iam,
  {
    kid: 'demo-only',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    previousKid: '',
    previousPublicKey: '',
  },
);
const directory = mkdtempSync(join(tmpdir(), 'tmc-kiosk-demo-'));
const db = openDb(directory);
db.setKv(
  'snapshot',
  JSON.stringify(
    await employeeQr.snapshot([{ id: 'gate-demo', turnstileId: 'demo-turnstile', active: true }]),
  ),
);
db.setKv('snapshot_at', String(Date.now()));
// No snapshot/outbox/heartbeat loops: demo data never goes to a central server.
const snapshots = new SnapshotManager(db, new ServerClient('http://127.0.0.1:1'), 'demo-only');
snapshots.load();
const edge = createApp(db, snapshots, new MockTurnstile('open'));
const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', authenticate(iam), iamRoutes(iam));
app.get('/api/me/qr', requirePermission('self:read'), async (_req, res) => {
  try {
    res.json(await employeeQr.liveQr(res.locals.user.employeeId));
  } catch (error) {
    if (!(error instanceof QrNotIssuableError)) throw error;
    res.status(403).json({ error: error.message, reason: error.reason });
  }
});
app.get('/demo/phone-url', (_req, res) =>
  res.json({
    url: host === '0.0.0.0' && phoneAddress ? `http://${phoneAddress}:3100/portal/qr` : null,
  }),
);
app.get('/demo/person', (_req, res) => res.redirect('/kiosk?gateId=gate-demo'));

app.post('/api/kiosk/scan', (req, res, next) => {
  if (req.body?.gateId !== 'gate-demo') {
    res.status(400).json({ error: 'Demo accepts only gate-demo' });
    return;
  }
  req.url = '/kiosk/scan';
  edge(req, res, next);
});
app.get('/demo/token', (req, res) => {
  const scenario = req.query.case ?? 'granted';
  if (!['granted', 'revoked', 'expired', 'invalid'].includes(String(scenario))) {
    res.status(400).json({ error: 'Unknown demo scenario' });
    return;
  }
  const exp = Math.floor(Date.now() / 1000) + (scenario === 'expired' ? -90 : 60);
  const token =
    scenario === 'invalid'
      ? 'invalid-demo-token'
      : signQrToken(
          {
            sub: scenario === 'revoked' ? 'demo-revoked' : 'demo-active',
            exp,
            jti: randomUUID(),
          },
          'demo-only',
          privateKey,
        );
  res.json({
    token,
    expiresAt: exp * 1000,
    svg: renderToStaticMarkup(createElement(QRCodeSVG, { value: token, size: 220, marginSize: 4 })),
  });
});
app.get('/', (_req, res) =>
  res.type('html').send(`<!doctype html>
<html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Thử quét QR — TMC Kiosk</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f3f6fc;color:#17263f;font:15px system-ui,sans-serif}main{display:grid;grid-template-columns:330px 1fr;min-height:100vh}.controls{padding:24px;background:white;border-right:1px solid #e0e6f0}h1{font-size:24px;line-height:1.3;margin:10px 0 16px}.badge{display:inline-block;background:#e9f8f0;color:#15834c;padding:5px 10px;border-radius:20px;font-size:12px;font-weight:600}p{line-height:1.5;color:#65748b}label{display:block;font-weight:600;margin:20px 0 8px}select,button{font:inherit;border:1px solid #dfe5ef;border-radius:8px;padding:12px;width:100%;background:white;color:#17263f}button{cursor:pointer;margin-top:10px}button.primary{background:rgb(42,92,206);color:white;border:0;font-weight:600}button:disabled{opacity:.5;cursor:wait}#qr{display:grid;place-items:center;margin:18px 0;background:white}#qr svg{max-width:100%;height:auto}#expiry{font-size:13px;text-align:center}#notice{font-size:13px;color:#17263f;min-height:40px}iframe{width:100%;height:100vh;border:0;background:white}@media(max-width:800px){main{grid-template-columns:1fr}.controls{border-right:0}iframe{height:700px}}
</style><main><aside class="controls"><span class="badge">Cổng giả lập · dữ liệu mẫu</span><h1>Thử quét QR tại kiosk</h1><p>Chọn tình huống, rồi bấm <strong>Quét thử</strong>. Kiosk bên phải xử lý mã qua edge và tự trở về chờ sau 3 giây.</p>
<label for="scenario">Tình huống</label><select id="scenario"><option value="granted">Hợp lệ → Cho phép</option><option value="revoked">Đã thu hồi → Từ chối (REVOKED)</option><option value="expired">Hết hạn → Từ chối (EXPIRED)</option><option value="invalid">Không hợp lệ → Từ chối</option></select>
<div id="qr" aria-label="Mã QR mẫu"></div><p id="expiry"></p><button class="primary" id="scan">Quét thử</button><button id="renew">Tạo mã QR mới</button><p id="notice" role="status">Đang chuẩn bị mã mẫu…</p><p style="font-size:13px">Bấm Quét thử lần nữa với cùng mã hợp lệ để xem REPLAYED. Nếu có máy quét USB, click vùng kiosk rồi quét QR này bằng máy quét.</p><p style="font-size:12px">Mã demo chỉ dùng trong phiên này. Kiosk chính tự mở camera. Cổng được giả lập và dữ liệu không đồng bộ lên server.</p></aside><iframe id="kiosk" title="Kiosk thử nghiệm" src="/kiosk?gateId=gate-demo"></iframe></main>
<script>
const scenario=document.getElementById('scenario'), frame=document.getElementById('kiosk'), notice=document.getElementById('notice'), scan=document.getElementById('scan');let current;
async function renew(){scan.disabled=true;try{const response=await fetch('/demo/token?case='+scenario.value);if(!response.ok)throw Error('Không tạo được mã');current=await response.json();document.getElementById('qr').innerHTML=current.svg;notice.textContent='Mã mới đã sẵn sàng.';}catch(error){current=null;notice.textContent=error.message;}finally{scan.disabled=!current;}}
scenario.addEventListener('change',renew);document.getElementById('renew').addEventListener('click',renew);
scan.addEventListener('click',async()=>{if(!current)return;const doc=frame.contentDocument,input=doc&&doc.getElementById('scanner-input');if(!input){notice.textContent='Kiosk đang tải. Vui lòng thử lại.';return;}if(input.disabled){notice.textContent='Chờ kiosk trở về trạng thái chờ rồi quét tiếp.';return;}const setter=Object.getOwnPropertyDescriptor(frame.contentWindow.HTMLInputElement.prototype,'value').set;setter.call(input,current.token);input.dispatchEvent(new frame.contentWindow.Event('input',{bubbles:true}));await new Promise(requestAnimationFrame);input.form.requestSubmit();notice.textContent='Đã gửi mã qua đầu vào của máy quét. Xem kết quả ở kiosk.';});
setInterval(()=>{document.getElementById('expiry').textContent=!current?'':scenario.value==='expired'?'Mã mẫu đã hết hạn':scenario.value==='invalid'?'Mã mẫu không hợp lệ':Math.max(0,Math.ceil((current.expiresAt-Date.now())/1000))+' giây còn lại · tạo mã mới khi hết hạn';},500);renew();
</script></html>`),
);
// Serve the main frontend and the optional test controls from one origin.
app.use(async (req, res) => {
  if (req.method !== 'GET') {
    res.sendStatus(404);
    return;
  }
  try {
    const upstream = await fetch('http://127.0.0.1:5173' + req.originalUrl);
    res.status(upstream.status);
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') ?? 'application/octet-stream',
    );
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).send('Start Vite on 127.0.0.1:5173 first.');
  }
});
const server = app.listen(3100, host, () => {
  console.log('Kiosk QR demo: http://127.0.0.1:3100/');
  console.log('Camera kiosk: http://127.0.0.1:3100/kiosk?gateId=gate-demo');
  if (host === '0.0.0.0' && phoneAddress)
    console.log(`Phone portal: http://${phoneAddress}:3100/portal/qr (an.demo / DemoEmployee123!)`);
});
server.on('error', (error) => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
  console.error(
    error.code === 'EADDRINUSE'
      ? 'Port 3100 is busy. Stop the previous edge/demo before running npm run demo:kiosk.'
      : error,
  );
  process.exit(1);
});
const shutdown = () => {
  server.closeAllConnections();
  server.close(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
