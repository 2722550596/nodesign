/**
import crypto from 'node:crypto';
 * server/_probe-tier-gates.mjs — 对着真服务端攻一遍账户层级闸（08-21）。
 *   node server/_probe-tier-gates.mjs [base=http://127.0.0.1:4001]
 * 注册一个公开号（无邀请码），逐条打：/api/me/models 的 default、订阅名一律拒
 * （M3b 订阅通道删除后：MODEL_NOT_ALLOWED / UNKNOWN_MODEL，不再有 MODEL_LOCKED）、
 * turn 带 sonnet 拒、chatai 403、热切 runs/:rid/model 带订阅名 400。
 */
const BASE = process.argv[2] || 'http://127.0.0.1:4001';
const tag = Date.now().toString(36);
const jar = {};
async function call(method, path, body, cookie) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setc = r.headers.get('set-cookie'); if (setc) jar.last = setc.split(';')[0];
  let j; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, j };
}
const results = [];
const check = (name, ok, detail) => { results.push([ok ? '✓' : '✗', name, detail]); };

const st = await call('GET', '/api/auth/status');
check('status.openRegistration=true', st.j?.openRegistration === true, JSON.stringify(st.j));
const reg = await call('POST', '/api/auth/register', { username: `gateprobe_${tag}`, password: 'probe-pass-12345' });
check('公开注册 201', reg.status === 201, `${reg.status} ${JSON.stringify(reg.j).slice(0, 120)}`);
const cookie = jar.last;
const me = await call('GET', '/api/me/models', null, cookie);
const opts = me.j?.options || [];
check('默认模型=ox-alpha', me.j?.default === 'ox-alpha', JSON.stringify(me.j?.default));
check('清单里没有任何订阅行（M3b 订阅通道删除）', opts.filter(o => /claude-/.test(o.id)).length === 0, JSON.stringify(opts.map(o => o.id)));
check('ox-alpha 在清单里', opts.some(o => o.id === 'ox-alpha'), '');
const proj = await call('POST', '/api/projects', { name: `gateprobe ${tag}` }, cookie);
const pid = proj.j?.project?.id || proj.j?.id;
check('建项目', proj.status < 300 && !!pid, `${proj.status} ${pid}`);
if (pid) {
  const sid = crypto.randomUUID();
  const t1 = await call('POST', `/api/projects/${pid}/turn`, { chat: 'hi', sessionId: sid, model: 'claude-sonnet-5[1m]', requestId: `r-${tag}-1` }, cookie);
  check('turn 带 sonnet → 拒（403 MODEL_NOT_ALLOWED / 400 UNKNOWN_MODEL，M3b 后无 MODEL_LOCKED）', (t1.status === 403 && t1.j?.code === 'MODEL_NOT_ALLOWED') || (t1.status === 400 && t1.j?.code === 'UNKNOWN_MODEL'), `${t1.status} ${t1.j?.code}`);
  const t2 = await call('POST', `/api/projects/${pid}/turn`, { chat: 'hi', sessionId: sid, model: 'gemini-3.7-flash', requestId: `r-${tag}-2` }, cookie);
  check('turn 带 gemini（看不见的）→ 拒（403 MODEL_NOT_ALLOWED / 400 UNKNOWN_MODEL）', (t2.status === 403 && t2.j?.code === 'MODEL_NOT_ALLOWED') || (t2.status === 400 && t2.j?.code === 'UNKNOWN_MODEL'), `${t2.status} ${t2.j?.code}`);
  const pm = await call('PUT', `/api/projects/${pid}/sessions/${sid}/model`, { model: 'claude-opus-5[1m]' }, cookie);
  check('PUT 会话模型 opus → 拒（400 UNKNOWN_MODEL / 403 MODEL_NOT_ALLOWED）', (pm.status === 400 && pm.j?.code === 'UNKNOWN_MODEL') || (pm.status === 403 && pm.j?.code === 'MODEL_NOT_ALLOWED'), `${pm.status} ${pm.j?.code}`);
  const gm = await call('GET', `/api/projects/${pid}/sessions/${sid}/model`, null, cookie);
  check('GET 会话模型 default=ox-alpha', gm.j?.default === 'ox-alpha' && gm.j?.model === 'ox-alpha', JSON.stringify({ model: gm.j?.model, default: gm.j?.default }));
  const ca = await call('POST', `/api/projects/${pid}/chatai/turn`, { input: 'hi' }, cookie);
  check('chatai 演出 → 403', ca.status === 403, `${ca.status} ${JSON.stringify(ca.j).slice(0, 100)}`);
  const hot = await call('POST', `/api/projects/${pid}/runs/run_nonexistent/model`, { model: 'claude-sonnet-5[1m]' }, cookie);
  check('热切 runs/:rid/model 带订阅名 → 400 UNKNOWN_MODEL（白名单在 run 查询之前，见 turn-model-switch.js）', hot.status === 400 && hot.j?.code === 'UNKNOWN_MODEL', `${hot.status} ${hot.j?.code}`);
  await call('DELETE', `/api/projects/${pid}`, null, cookie);
}
console.log(results.map(r => r.join('  ')).join('\n'));
console.log(`\n公开号 gateprobe_${tag} 已建（登录墙口径上它是真用户），请在 admin 控制台停用或留作对照。失败 ${results.filter(r => r[0] === '✗').length} 项`);
