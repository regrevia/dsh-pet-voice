#!/usr/bin/env node
/**
 * 把 Cloudflare Tunnel 的 token + 公开主机名安全落到本机（给 scripts/tunnel.sh --named 用）。
 *
 *   node scripts/cf-tunnel-token.mjs                     # 粘贴（Ctrl-D 结束），校验后原子落盘
 *   node scripts/cf-tunnel-token.mjs --clipboard         # 直接读 macOS 剪贴板
 *   node scripts/cf-tunnel-token.mjs --file paste.txt
 *   node scripts/cf-tunnel-token.mjs --host pet.example.com   # 顺带存主机名（也可从粘贴里认出来）
 *   node scripts/cf-tunnel-token.mjs --check             # 只校验已保存的两份文件
 *   node scripts/cf-tunnel-token.mjs --show              # 掩码展示已保存的值
 *   node scripts/cf-tunnel-token.mjs --check-cloudflared # 顺带看 cloudflared 装没装
 *
 * 它认这几种粘贴形态（整段控制台文本直接丢进来也行）：
 *   sudo cloudflared service install eyJhIjoi...
 *   cloudflared tunnel run --token eyJhIjoi...
 *   eyJhIjoi...                      （裸 token）
 *   pet.example.com                  （主机名，可和上面混在一起）
 *
 * 安全约定（和 scripts/cf-creds.mjs 一致）：
 *   - 全程不打印 token/secret 原文，只打印掩码 + 长度 + 解出来的「形状」；
 *   - 目录 0700、文件 0600，同目录临时文件 + rename 原子落盘；
 *   - 落在仓库外（默认 ~/.dsh/pet-voice/），落点在仓库或当前项目目录里必须显式 --allow-repo；
 *   - 校验不过不写文件——半个 token 比没有更难查。
 *
 * token 是什么：base64(JSON {a: 账户ID, t: 隧道UUID, s: 隧道密钥})。
 * 拿到它就等于拿到「往你这台机器内网打洞」的权限，所以只落盘、不进对话、不进命令行参数。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const PV_DIR = join(homedir(), '.dsh', 'pet-voice');
const DEFAULT_TOKEN = join(PV_DIR, 'cloudflared.token');
const DEFAULT_HOST = join(PV_DIR, 'cloudflared.host');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const OPT = {
  clipboard: has('--clipboard'),
  check: has('--check'),
  show: has('--show'),
  cloudflared: has('--check-cloudflared'),
  allowRepo: has('--allow-repo'),
  quiet: has('--quiet'),
  file: val('--file'),
  host: val('--host'),
  destToken: resolve(val('--dest-token') || DEFAULT_TOKEN),
  destHost: resolve(val('--dest-host') || DEFAULT_HOST),
};

const out = (s = '') => { if (!OPT.quiet) process.stdout.write(`${s}\n`); };
const err = (s) => process.stderr.write(`${s}\n`);

/** 只留头尾，中间打码。 */
function mask(v) {
  if (!v) return '（空）';
  if (v.length < 12) return `${'*'.repeat(v.length)}（${v.length} 位）`;
  return `${v.slice(0, 6)}…${v.slice(-4)}（${v.length} 位）`;
}

const isBase64Json = (s) => {
  if (typeof s !== 'string' || !s.startsWith('eyJ')) return false;
  // 'eyJ' 解出来就是 `{"`，这里只确认第一个字节是 '{'，具体结构交给 JSON.parse
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')[0] === 0x7b;
};

function b64ToJson(s) {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b + '='.repeat((4 - (b.length % 4)) % 4);
  const text = Buffer.from(pad, 'base64').toString('utf8');
  return JSON.parse(text);
}

function inGitRepo(path) {
  let dir = dirname(path);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** 落点护栏：不许写进当前项目目录或任何 git 仓库（除非 --allow-repo）。 */
function guardDest(dest, label) {
  const cwd = process.cwd();
  const underCwd = dest === cwd || dest.startsWith(cwd + sep);
  if (underCwd && !OPT.allowRepo) {
    err(`拒写：${label} ${dest} 在当前项目目录里（换成 ~/.dsh/... 或加 --allow-repo）`);
    process.exit(2);
  }
  const repo = inGitRepo(dest);
  if (repo && !OPT.allowRepo) {
    err(`拒写：${label} ${dest} 在 git 仓库 ${repo} 里（默认不把秘密放进仓库；确实要写加 --allow-repo）`);
    process.exit(2);
  }
}

function writeSecret(path, body, label) {
  guardDest(path, label);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(path), 0o700); } catch { /* 非 POSIX 就算了 */ }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, path);
  } catch (e) {
    err(`写 ${path} 失败：${e.message}`);
    process.exit(2);
  }
  chmodSync(path, 0o600);
}

/* ---------------- 解析 ---------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_RE = /^[0-9a-f]{32}$/i;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function normalizeHost(raw) {
  if (!raw) return null;
  let h = String(raw).trim().replace(/^[a-z]+:\/\//i, '');   // 去掉 https://
  h = h.split('/')[0].split('?')[0].split('#')[0];           // 去掉路径/查询
  h = h.replace(/:\d+$/, '');                                // 去掉端口
  h = h.replace(/\.$/, '').toLowerCase();
  return h || null;
}

/**
 * 从一段文本里认出 token 与主机名。
 * token 优先取 `--token X` / `service install X` 后面的值，其次取任何 eyJ... 串（取最长的那个）。
 */
export function parsePaste(text) {
  const t = String(text || '').replace(/\r/g, '');
  const res = { token: null, host: null, candidates: 0 };
  const found = [];

  for (const m of t.matchAll(/(?:--token[=\s]+|service\s+install[=\s]+)([A-Za-z0-9_+/=-]{20,})/gi)) {
    found.push(m[1]);
  }
  for (const m of t.matchAll(/\b(eyJ[A-Za-z0-9_+/=-]{12,})/g)) {
    found.push(m[1]);
  }
  res.candidates = found.length;
  if (found.length) {
    // 最长的那个几乎一定是完整 token（截断复制的短片段会被排除）
    res.token = found.sort((a, b) => b.length - a.length)[0].replace(/[.,;:]+$/, '');
  }

  const hosts = [];
  for (const m of t.matchAll(/\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/gi)) {
    const h = normalizeHost(m[1]);
    if (!h) continue;
    if (/cloudflarestorage\.com$/.test(h)) continue;   // R2 端点不是主机名
    if (/cloudflare\.com$/.test(h) && !/cfargotunnel/.test(h)) continue;
    hosts.push(h);
  }
  // 明确的自有域名优先：排除 trycloudflare / cfargotunnel 这类平台域名
  const own = hosts.filter((h) => !/trycloudflare\.com$/.test(h) && !/cfargotunnel\.com$/.test(h));
  res.host = own[0] || hosts[0] || null;
  return res;
}

export function validateToken(token) {
  const problems = [];
  if (!token) return { ok: false, problems: ['没认出 token（控制台里那串以 eyJ 开头的）'] };
  if (!isBase64Json(token)) problems.push('token 不是 base64 的 JSON（正常应以 eyJhIjoi 开头）');
  if (token.length > 2000) problems.push(`token 异常长（${token.length} 位）`);

  let obj = null;
  if (!problems.length) {
    try {
      obj = b64ToJson(token);
    } catch {
      problems.push('token 解不开（base64/JSON 都不是合法结构，可能复制少了字符）');
    }
  }
  if (obj) {
    if (typeof obj.a !== 'string' || !ACCOUNT_RE.test(obj.a)) problems.push('解出来的账户 ID（a）不是 32 位十六进制');
    if (typeof obj.t !== 'string' || !UUID_RE.test(obj.t)) problems.push('解出来的隧道 ID（t）不是 UUID');
    if (typeof obj.s !== 'string' || obj.s.length < 40) problems.push('解出来的隧道密钥（s）长度不足 40');
  }
  return {
    ok: problems.length === 0,
    problems,
    info: obj
      ? {
          account: obj.a,
          tunnel: obj.t,
          secretLen: typeof obj.s === 'string' ? obj.s.length : 0,
          keys: Object.keys(obj).sort().join(','),
        }
      : null,
  };
}

function validateHost(host) {
  const problems = [];
  if (!host) return { ok: true, problems, skip: true };
  if (/^[a-z]+:\/\//i.test(host)) problems.push('主机名不要带协议（写 pet.example.com，不写 https://…）');
  if (!HOST_RE.test(host)) problems.push('主机名形状不对（要像 pet.example.com）');
  if (!host.includes('.')) problems.push('主机名至少要有两级域（pet.example.com）');
  if (/trycloudflare\.com$/.test(host)) problems.push('trycloudflare 是临时隧道域名，命名隧道要写你自己的域名');
  if (/cfargotunnel\.com$/.test(host)) problems.push('cfargotunnel 是隧道内部地址，不是给人访问的主机名');
  return { ok: problems.length === 0, problems, host };
}

/* ---------------- 模式下行为 ---------------- */

function readInput() {
  if (OPT.file) {
    const p = resolve(OPT.file);
    if (!existsSync(p)) { err(`读不到 ${p}`); process.exit(2); }
    return readFileSync(p, 'utf8');
  }
  if (OPT.clipboard) {
    try {
      return execFileSync('pbpaste', { encoding: 'utf8', maxBuffer: 1 << 20 });
    } catch {
      err('读剪贴板失败（pbpaste 不可用）；换 --file 或直接粘贴');
      process.exit(2);
    }
  }
  if (process.stdin.isTTY) {
    err('把控制台里那段（含 eyJ… 的行）粘进来，Ctrl-D 结束：');
  }
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function showSaved() {
  const tPath = OPT.destToken;
  const hPath = OPT.destHost;
  if (!existsSync(tPath)) {
    err(`没有 ${tPath}（先跑一次不带 --show 的保存）`);
    process.exit(1);
  }
  const token = readFileSync(tPath, 'utf8').trim();
  const st = statSync(tPath);
  out(`token  ${mask(token)}  ${tPath}  mode=${(st.mode & 0o777).toString(8)}`);
  const v = validateToken(token);
  if (v.ok && v.info) {
    out(`  账户 ${v.info.account.slice(0, 4)}…${v.info.account.slice(-4)}  隧道 ${v.info.tunnel}  密钥 ${v.info.secretLen} 位  keys=${v.info.keys}`);
  } else {
    out(`  ⚠ 解不开：${v.problems.join('；')}`);
  }
  if (existsSync(hPath)) {
    const h = readFileSync(hPath, 'utf8').trim();
    const hs = statSync(hPath);
    out(`host   ${h}  ${hPath}  mode=${(hs.mode & 0o777).toString(8)}`);
    const hv = validateHost(h);
    if (!hv.ok) out(`  ⚠ ${hv.problems.join('；')}`);
  } else {
    out(`host   （未保存，tunnel.sh --named 会拒跑）`);
  }
}

function checkSaved() {
  let bad = 0;
  if (!existsSync(OPT.destToken)) {
    err(`✗ 缺 token 文件 ${OPT.destToken}`);
    bad++;
  } else {
    const token = readFileSync(OPT.destToken, 'utf8').trim();
    const v = validateToken(token);
    if (v.ok) out(`✓ token 结构合法：${mask(token)}（${v.info.tunnel}）`);
    else { err(`✗ token 不合法：${v.problems.join('；')}`); bad++; }
    const mode = statSync(OPT.destToken).mode & 0o777;
    if (mode === 0o600) out('✓ token 权限 600');
    else { err(`✗ token 权限是 ${mode.toString(8)}，应为 600（chmod 600 一下）`); bad++; }
  }
  if (!existsSync(OPT.destHost)) {
    err(`✗ 缺主机名文件 ${OPT.destHost}`);
    bad++;
  } else {
    const h = readFileSync(OPT.destHost, 'utf8').trim();
    const hv = validateHost(h);
    if (hv.ok) out(`✓ 主机名合法：${h}`);
    else { err(`✗ 主机名不合法：${hv.problems.join('；')}`); bad++; }
    const mode = statSync(OPT.destHost).mode & 0o777;
    if (mode === 0o600) out('✓ 主机名权限 600');
    else { err(`✗ 主机名权限是 ${mode.toString(8)}，应为 600`); bad++; }
  }
  if (OPT.cloudflared) {
    try {
      const v = execFileSync('cloudflared', ['--version'], { encoding: 'utf8' }).trim();
      out(`✓ cloudflared 在：${v}`);
    } catch {
      out('· cloudflared 没装（brew install cloudflared，或用 scripts/tunnel.sh 里的 npx 兜底）');
    }
  }
  if (bad) { err(`\n${bad} 项不过；修好后重跑本脚本`); process.exit(1); }
  out('\n两份文件都合法，可以起命名隧道：bash scripts/tunnel.sh --named');
}

/* ---------------- 主流程 ---------------- */

const text = (OPT.check || OPT.show) ? '' : readInput();
const parsed = (OPT.check || OPT.show) ? { token: null, host: null } : parsePaste(text);
const token = parsed.token;
const hostArg = OPT.host ? normalizeHost(OPT.host) : parsed.host;
const host = hostArg || null;

if (OPT.show) { showSaved(); process.exit(0); }
if (OPT.check) { checkSaved(); process.exit(0); }

if (!text.trim()) {
  err('没收到内容（Ctrl-D 之前什么都没粘进来）');
  process.exit(2);
}

const vt = validateToken(token);
if (!vt.ok) {
  err('✗ token 校验不过：');
  for (const p of vt.problems) err(`  - ${p}`);
  err('\n提示：控制台里那两行（service install / tunnel run --token）后面那串 eyJ… 就是 token，');
  err('      复制整行也行，脚本会自己挑；复制不全（少了尾巴）会被上面的 base64/JSON 校验挡下来。');
  err('没写任何文件。');
  process.exit(1);
}

const vh = validateHost(host);
if (!vh.ok) {
  err('✗ 主机名校验不过：');
  for (const p of vh.problems) err(`  - ${p}`);
  err('没写任何文件。');
  process.exit(1);
}

out('解析结果（全部打码，不回显原文）');
out(`  令牌  ${mask(token)}`);
out(`        账户 ${vt.info.account.slice(0, 4)}…${vt.info.account.slice(-4)}（32 位 hex）  隧道 ${vt.info.tunnel}  密钥 ${vt.info.secretLen} 位  keys=${vt.info.keys}`);
out(`  主机名 ${host || '（这次没给，只写 token；tunnel.sh --named 还需要 cloudflared.host）'}`);
if (parsed.candidates > 1) out(`  （粘贴里出现 ${parsed.candidates} 个 eyJ… 片段，已取最长的那个）`);

writeSecret(OPT.destToken, `${token}\n`, 'token 文件');
out(`  → 已写 ${OPT.destToken}（600，${token.length} B）`);
if (host) {
  writeSecret(OPT.destHost, `${host}\n`, '主机名文件');
  out(`  → 已写 ${OPT.destHost}（600）`);
}

if (OPT.cloudflared) {
  try {
    out(`  cloudflared ${execFileSync('cloudflared', ['--version'], { encoding: 'utf8' }).trim()}`);
  } catch {
    out('  cloudflared 没装：brew install cloudflared（或用 npx 兜底）');
  }
}

out('\n下一步：bash scripts/tunnel.sh --named');
