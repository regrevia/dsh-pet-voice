#!/usr/bin/env node
/**
 * scripts/cf-tunnel-token.mjs 的离线自测：不联网、不碰真 token、只在自己的临时 HOME 里写文件。
 *   node scripts/cf-tunnel-token.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./cf-tunnel-token.mjs', import.meta.url).pathname;
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  ← ${detail}` : ''}`); }
};

/* ---- 假 token（形状和真的完全一致，只是值是编的） ---- */
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TUNNEL = '11111111-2222-4333-8444-555555555555';
const SECRET = 'Zm9vYmFy'.repeat(8); // 64 位
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const TOKEN = b64({ a: ACCOUNT, t: TUNNEL, s: SECRET });
const GOOD_HOST = 'pet.example.com';

const home = mkdtempSync(join(tmpdir(), 'cftt-'));
const run = (args, input = '', extraEnv = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    input,
    encoding: 'utf8',
    cwd: extraEnv.cwd || process.cwd(),
    env: { ...process.env, HOME: home, ...(extraEnv.env || {}) },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};
const tokenPath = join(home, '.dsh', 'pet-voice', 'cloudflared.token');
const hostPath = join(home, '.dsh', 'pet-voice', 'cloudflared.host');
const clean = () => rmSync(join(home, '.dsh'), { recursive: true, force: true });

console.log('1) 三种粘贴形态都能认出 token');
let r = run([], `sudo cloudflared service install ${TOKEN}\n`);
check('service install 行 → 退出 0', r.code === 0, `code=${r.code} ${r.err.slice(0, 120)}`);
check('token 文件内容就是那条 token（无多余空白）', existsSync(tokenPath) && readFileSync(tokenPath, 'utf8').trim() === TOKEN);

clean();
r = run([], `cloudflared tunnel run --token ${TOKEN}\n`);
check('tunnel run --token 行 → 退出 0', r.code === 0, `code=${r.code}`);
check('落盘正确', existsSync(tokenPath) && readFileSync(tokenPath, 'utf8').trim() === TOKEN);

clean();
r = run([], `${TOKEN}\n`);
check('裸 token → 退出 0', r.code === 0, `code=${r.code}`);

clean();
r = run([], `install ${TOKEN}\nand also a half copy ${TOKEN.slice(0, 30)}\n`);
check('同时出现完整和截断片段 → 取最长的那个', existsSync(tokenPath) && readFileSync(tokenPath, 'utf8').trim() === TOKEN, r.err.slice(0, 120));

console.log('2) 主机名：能认出来 / 能规范化 / 明显不对就拒');
clean();
r = run([], `sudo cloudflared service install ${TOKEN}\nPublic hostname: https://${GOOD_HOST}/pet-voice\n`);
check('从粘贴里认出主机名并去掉协议/路径', existsSync(hostPath) && readFileSync(hostPath, 'utf8').trim() === GOOD_HOST, r.err.slice(0, 160));

clean();
r = run(['--host', 'HTTPS://Pet.Example.COM:443/x'], `${TOKEN}\n`);
check('--host 大写成小写、去端口/路径', existsSync(hostPath) && readFileSync(hostPath, 'utf8').trim() === GOOD_HOST);

clean();
r = run(['--host', 'localhost'], `${TOKEN}\n`);
check('主机名 localhost → 拒（退出 1）', r.code === 1, `code=${r.code}`);
check('拒了就不写任何文件', !existsSync(tokenPath) && !existsSync(hostPath));

clean();
r = run(['--host', 'abc.trycloudflare.com'], `${TOKEN}\n`);
check('trycloudflare 临时域名 → 拒', r.code === 1 && /trycloudflare/.test(r.err), `code=${r.code}`);

clean();
r = run(['--host', 'x.cfargotunnel.com'], `${TOKEN}\n`);
check('cfargotunnel 内部地址 → 拒', r.code === 1 && /cfargotunnel/.test(r.err), `code=${r.code}`);

console.log('3) token 形状不对必须挡下来（复制少了字符是最常见的）');
clean();
r = run([], `sudo cloudflared service install ${TOKEN.slice(0, TOKEN.length - 8)}\n`);
check('截断 token → 退出 1 且提示 base64/JSON', r.code === 1 && /base64|JSON|解不开/.test(r.err), `code=${r.code} ${r.err.slice(0, 160)}`);
check('截断 token 不落盘', !existsSync(tokenPath));

clean();
r = run([], `${b64({ a: ACCOUNT, t: TUNNEL })}\n`); // 缺 s
check('缺隧道密钥 s → 拒', r.code === 1 && /s\)|密钥/.test(r.err), `code=${r.code} ${r.err.slice(0, 160)}`);

clean();
r = run([], `${b64({ a: 'nothex', t: TUNNEL, s: SECRET })}\n`);
check('账户 ID 不是 32 位 hex → 拒', r.code === 1 && /账户/.test(r.err), `code=${r.code}`);

clean();
r = run([], `${b64({ a: ACCOUNT, t: 'not-a-uuid', s: SECRET })}\n`);
check('隧道 ID 不是 UUID → 拒', r.code === 1 && /UUID/.test(r.err), `code=${r.code}`);

clean();
r = run([], 'hello world，没有 token\n');
check('完全没 token → 退出 1', r.code === 1 && /没认出 token/.test(r.err), `code=${r.code}`);

console.log('4) 落盘权限与打码');
clean();
r = run([], `${TOKEN}\n${GOOD_HOST}\n`);
const tm = existsSync(tokenPath) ? statSync(tokenPath).mode & 0o777 : -1;
const hm = existsSync(hostPath) ? statSync(hostPath).mode & 0o777 : -1;
const dm = existsSync(join(home, '.dsh', 'pet-voice')) ? statSync(join(home, '.dsh', 'pet-voice')).mode & 0o777 : -1;
check('token 文件 600', tm === 0o600, tm.toString(8));
check('主机名文件 600', hm === 0o600, hm.toString(8));
check('目录 700', dm === 0o700, dm.toString(8));
check('stdout 里没有完整 token', !r.out.includes(TOKEN), '输出把 token 打出来了');
check('stdout 里有掩码和形状', /eyJhIj…/.test(r.out) && new RegExp(TUNNEL).test(r.out), r.out.slice(0, 200));

console.log('5) --check / --show');
r = run(['--check']);
check('--check 合格 → 退出 0 + 四条 ✓', r.code === 0 && (r.out.match(/✓/g) || []).length >= 4, `code=${r.code} ${r.out.slice(0, 200)}`);

clean();
r = run(['--check']);
check('缺文件时 --check → 退出 1', r.code === 1 && /缺 token/.test(r.err), `code=${r.code}`);

clean();
run([], `${TOKEN}\n${GOOD_HOST}\n`);
r = run(['--show']);
check('--show 回显掩码、不回显原文', r.code === 0 && /eyJhIj…/.test(r.out) && !r.out.includes(TOKEN), r.out.slice(0, 200));
check('--show 打出账户/隧道/密钥长度', new RegExp(TUNNEL).test(r.out) && /密钥 64 位/.test(r.out), r.out.slice(0, 300));

console.log('6) 落点护栏：不许把 token 写进项目目录');
clean();
const repoDir = mkdtempSync(join(tmpdir(), 'cftt-cwd-'));
writeFileSync(join(repoDir, '.git'), 'gitdir: x\n'); // 假仓库
r = run(['--dest-token', join(repoDir, 'cloudflared.token')], `${TOKEN}\n`, { cwd: repoDir });
check('落在当前项目目录 → 退出 2（拒写）', r.code === 2, `code=${r.code} ${r.err.slice(0, 120)}`);
check('护栏拒绝后没有文件', !existsSync(join(repoDir, 'cloudflared.token')));

r = run(['--dest-token', join(repoDir, 'ok.token'), '--allow-repo'], `${TOKEN}\n`, { cwd: repoDir });
check('--allow-repo 时能写（显式同意才给）', r.code === 0 && existsSync(join(repoDir, 'ok.token')), `code=${r.code} ${r.err.slice(0, 120)}`);

rmSync(repoDir, { recursive: true, force: true });
clean();
rmSync(home, { recursive: true, force: true });

console.log(`\ncf-tunnel-token 自测：${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
