#!/usr/bin/env node
/**
 * 把 Cloudflare（R2 / API 令牌）凭证安全落到本机。
 *
 *   node scripts/cf-creds.mjs                 # 粘贴（Ctrl-D 结束），先校验再写
 *   node scripts/cf-creds.mjs --clipboard     # 直接读 macOS 剪贴板
 *   node scripts/cf-creds.mjs --file paste.txt
 *   node scripts/cf-creds.mjs --check         # 只校验已保存的凭证
 *   node scripts/cf-creds.mjs --show          # 掩码展示已保存的凭证
 *   node scripts/cf-creds.mjs --offline       # 跳过联网校验（只做形状校验）
 *   node scripts/cf-creds.mjs --dest ~/x.env  # 换落点（默认 ~/.dsh/cloudflare/creds.env）
 *
 * 安全约定：
 *   - 全程不打印任何秘密值，只打印掩码 + 长度；
 *   - 目录 0700 / 文件 0600，同目录临时文件 + rename 原子落盘；
 *   - 默认落点在仓库外；落点若在 git 仓库里必须显式 --allow-repo；
 *   - 失败不写文件（半截凭证比没凭证更危险）。
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_DEST = join(homedir(), '.dsh', 'cloudflare', 'creds.env');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const OPT = {
  offline: has('--offline'),
  check: has('--check'),
  show: has('--show'),
  clipboard: has('--clipboard'),
  allowRepo: has('--allow-repo'),
  file: val('--file'),
  dest: resolve(val('--dest') || DEFAULT_DEST),
};

const say = (s = '') => process.stdout.write(`${s}\n`);
const warn = (s) => process.stderr.write(`${s}\n`);

/** 只留头尾，中间打码；短值全打码。 */
function mask(v) {
  if (!v) return '（空）';
  if (v.length < 12) return `${'*'.repeat(v.length)}（${v.length} 位）`;
  return `${v.slice(0, 4)}…${v.slice(-4)}（${v.length} 位）`;
}

const LABELS = {
  accountId: ['帐户id', '账户id', 'accountid', 'account_id', 'account-id'],
  apiToken: ['api令牌', 'apitoken', 'api_token', '令牌', 'token'],
  accessKeyId: ['访问密钥id', '访问密钥', 'accesskeyid', 'access_key_id', 'access-key-id'],
  secretAccessKey: ['秘密访问密钥', 'secretaccesskey', 'secret_access_key', 'secret-access-key'],
  endpoint: ['s3api端点', 's3端点', 's3apiendpoint', 's3endpoint', 'endpoint', 'r2endpoint'],
};

const norm = (s) => s.toLowerCase().replace(/[\s:：·*\-_]/g, '');

function labelOf(line) {
  const n = norm(line);
  if (!n) return null;
  for (const [key, list] of Object.entries(LABELS)) {
    for (const l of list) {
      if (n === norm(l) || (n.startsWith(norm(l)) && n.length <= norm(l).length + 3)) return key;
    }
  }
  return null;
}

/** 主路径：标签行 → 下一个非标签非空行取值为值。 */
function parseByLabels(lines) {
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const key = labelOf(lines[i]);
    if (!key || out[key]) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const cand = lines[j].trim();
      if (!cand) continue;
      if (labelOf(cand)) break;
      out[key] = cand;
      break;
    }
  }
  return out;
}

/** 兜底：全文正则，处理「值被复制成一整段、标签丢了」的粘贴。 */
function parseByShape(blob, out) {
  const hex32 = blob.match(/\b[0-9a-fA-F]{32}\b/g) || [];
  const hex64 = blob.match(/\b[0-9a-fA-F]{64}\b/g) || [];
  const tokens = blob.match(/\b[A-Za-z0-9_-]{40,}\b/g) || [];
  const urls = blob.match(/https:\/\/[0-9a-fA-F]{32}\.r2\.cloudflarestorage\.com\S*/g) || [];

  if (!out.accessKeyId) {
    out.accessKeyId = hex32.find((v) => v === v.toUpperCase() && /[A-F]/.test(v));
  }
  if (!out.accountId) {
    out.accountId = hex32.find((v) => v === v.toLowerCase() && /[a-f]/.test(v));
  }
  if (!out.secretAccessKey) out.secretAccessKey = hex64[0];
  if (!out.apiToken) {
    out.apiToken = tokens
      .filter((t) => !hex32.includes(t) && !hex64.includes(t))
      .sort((a, b) => b.length - a.length)[0];
  }
  if (!out.endpoint) out.endpoint = urls[0]?.replace(/\/+$/, '');
  return out;
}

function parse(blob) {
  const lines = blob.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out = parseByLabels(lines);
  if (Object.keys(out).length < 5) parseByShape(blob, out);
  for (const k of Object.keys(out)) {
    if (out[k] == null || out[k] === '') {
      delete out[k];
      continue;
    }
    out[k] = String(out[k]).trim().replace(/^["'`]|["'`]$/g, '');
    if (!out[k]) delete out[k];
  }
  if (out.accountId) out.accountId = out.accountId.toLowerCase();
  if (out.endpoint) out.endpoint = out.endpoint.replace(/\/+$/, '');
  return out;
}

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();

/** R2 的 S3 ListBuckets（SigV4，region=auto）——验的是 AK/SK 这对钥匙真能开桶。 */
async function s3ListBuckets(cred, timeoutMs = 15000) {
  const url = new URL(cred.endpoint);
  const host = url.host;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['GET', url.pathname || '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${cred.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const res = await fetch(url.origin + (url.pathname || '/'), {
    method: 'GET',
    headers: {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text().catch(() => '');
  const buckets = [...body.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
  return { ok: res.status === 200, status: res.status, buckets, body: body.slice(0, 400) };
}

/** API 令牌验活：/user/tokens/verify。 */
async function verifyApiToken(token, timeoutMs = 15000) {
  const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  const status = json?.result?.status || json?.errors?.[0]?.message || `HTTP ${res.status}`;
  return { ok: res.ok && json?.success === true, status: String(status), code: json?.errors?.[0]?.code };
}

/** 形状校验：只报字段名和规则，不报值。 */
function validateShape(c) {
  const problems = [];
  if (!c.accountId) problems.push('缺少「帐户 ID」（32 位十六进制）');
  else if (!/^[0-9a-f]{32}$/.test(c.accountId)) problems.push('「帐户 ID」应为 32 位十六进制');
  if (!c.accessKeyId) problems.push('缺少「访问密钥 ID」');
  else if (!/^[0-9A-Fa-f]{32}$/.test(c.accessKeyId)) problems.push('「访问密钥 ID」应为 32 位十六进制');
  if (!c.secretAccessKey) problems.push('缺少「秘密访问密钥」');
  else if (!/^[0-9a-fA-F]{64}$/.test(c.secretAccessKey)) problems.push('「秘密访问密钥」应为 64 位十六进制');
  if (!c.apiToken) problems.push('缺少「API 令牌」');
  else if (!/^[A-Za-z0-9_-]{40,}$/.test(c.apiToken)) problems.push('「API 令牌」应为 40 位以上的 base62/_- 串');

  if (!c.endpoint) {
    if (c.accountId && /^[0-9a-f]{32}$/.test(c.accountId)) {
      c.endpoint = `https://${c.accountId}.r2.cloudflarestorage.com`;
      c.endpointDerived = true;
    }
  } else {
    let u;
    try {
      u = new URL(c.endpoint);
    } catch {
      problems.push('「S3 API 端点」不是合法 URL');
    }
    if (u) {
      if (u.protocol !== 'https:') problems.push('「S3 API 端点」必须 https');
      const expect = c.accountId ? `${c.accountId}.r2.cloudflarestorage.com` : null;
      if (expect && u.host !== expect) problems.push(`「S3 API 端点」主机名与帐户 ID 不一致（应为 ${expect}）`);
    }
  }
  return problems;
}

function inGitRepo(path) {
  let dir = dirname(resolve(path));
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function writeSecretFile(dest, cred) {
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  const stamp = new Date().toISOString();
  const body = [
    `# Cloudflare 凭证（由 scripts/cf-creds.mjs 于 ${stamp} 写入）`,
    '# 用法： set -a; . ~/.dsh/cloudflare/creds.env; set +a',
    '# 这个文件是秘密：不要提交、不要截图、不要放进任何 public/ 目录。',
    `export CLOUDFLARE_ACCOUNT_ID=${cred.accountId}`,
    `export CLOUDFLARE_API_TOKEN=${cred.apiToken}`,
    `export R2_ACCESS_KEY_ID=${cred.accessKeyId}`,
    `export R2_SECRET_ACCESS_KEY=${cred.secretAccessKey}`,
    `export R2_ENDPOINT=${cred.endpoint}`,
    '',
  ].join('\n');
  const tmp = join(dir, `.creds.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  chmodSync(dest, 0o600);
  return { dir, size: body.length };
}

function readExisting(dest) {
  if (!existsSync(dest)) return null;
  const txt = readFileSync(dest, 'utf8');
  const get = (k) => txt.match(new RegExp(`export ${k}=(.*)`))?.[1]?.trim();
  return {
    accountId: get('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: get('CLOUDFLARE_API_TOKEN'),
    accessKeyId: get('R2_ACCESS_KEY_ID'),
    secretAccessKey: get('R2_SECRET_ACCESS_KEY'),
    endpoint: get('R2_ENDPOINT'),
  };
}

function report(c) {
  say('');
  say('解析结果（值一律打码）：');
  say(`  帐户 ID        ${mask(c.accountId)}`);
  say(`  API 令牌       ${mask(c.apiToken)}`);
  say(`  访问密钥 ID    ${mask(c.accessKeyId)}`);
  say(`  秘密访问密钥   ${mask(c.secretAccessKey)}`);
  say(`  S3 API 端点    ${c.endpoint}${c.endpointDerived ? '（由帐户 ID 推导）' : ''}`);
}

async function readInput() {
  if (OPT.file) {
    if (!existsSync(OPT.file)) throw new Error(`没有这个文件：${OPT.file}`);
    return readFileSync(OPT.file, 'utf8');
  }
  if (OPT.clipboard) {
    try {
      return execFileSync('pbpaste', { encoding: 'utf8' });
    } catch {
      throw new Error('读剪贴板失败（非 macOS？改用 --file 或直接粘贴）');
    }
  }
  if (process.stdin.isTTY) {
    warn('把 Cloudflare 页面上那几行（帐户 ID / API 令牌 / 访问密钥 ID / 秘密访问密钥 / S3 端点）整段粘进来，');
    warn('粘完按 Ctrl-D 结束。输入不会回显到日志，也不会写进任何 shell 历史。');
    warn('');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (OPT.show || OPT.check) {
    const c = readExisting(OPT.dest);
    if (!c) {
      warn(`没有已保存的凭证：${OPT.dest}`);
      process.exit(1);
    }
    const problems = validateShape(c);
    report(c);
    const st = statSync(OPT.dest);
    say(`  落点           ${OPT.dest}（权限 ${(st.mode & 0o777).toString(8)}）`);
    if (problems.length) {
      warn('');
      warn('形状校验未通过：');
      problems.forEach((p) => warn(`  ✗ ${p}`));
      process.exit(1);
    }
    if (OPT.offline) {
      say('');
      say('形状校验通过（--offline，未联网验活）');
      process.exit(0);
    }
    say('');
    say('联网验活中…');
    const [token, s3] = await Promise.allSettled([verifyApiToken(c.apiToken), s3ListBuckets(c)]);
    let bad = false;
    if (token.status === 'fulfilled' && token.value.ok) say(`  ✓ API 令牌有效（状态 ${token.value.status}）`);
    else {
      bad = true;
      warn(`  ✗ API 令牌验活失败：${token.status === 'fulfilled' ? token.value.status : token.reason.message}`);
    }
    if (s3.status === 'fulfilled' && s3.value.ok) {
      const b = s3.value.buckets;
      say(`  ✓ R2 凭证有效（ListBuckets 200，${b.length} 个桶${b.length ? `：${b.join(' / ')}` : ''}）`);
    } else {
      bad = true;
      const why = s3.status === 'fulfilled' ? `HTTP ${s3.value.status} ${s3.value.body.slice(0, 200)}` : s3.reason.message;
      warn(`  ✗ R2 凭证验活失败：${why}`);
    }
    process.exit(bad ? 2 : 0);
  }

  const blob = await readInput();
  if (!blob.trim()) {
    warn('没读到内容。用法：node scripts/cf-creds.mjs --clipboard  或整段粘贴后 Ctrl-D。');
    process.exit(1);
  }
  const cred = parse(blob);
  const problems = validateShape(cred);
  report(cred);
  if (problems.length) {
    warn('');
    warn('没通过校验，未写入任何文件：');
    problems.forEach((p) => warn(`  ✗ ${p}`));
    process.exit(1);
  }

  if (!OPT.offline) {
    say('');
    say('联网验活中…');
    const [token, s3] = await Promise.allSettled([verifyApiToken(cred.apiToken), s3ListBuckets(cred)]);
    let bad = false;
    if (token.status === 'fulfilled' && token.value.ok) say(`  ✓ API 令牌有效（状态 ${token.value.status}）`);
    else {
      bad = true;
      warn(`  ✗ API 令牌验活失败：${token.status === 'fulfilled' ? token.value.status : token.reason.message}`);
    }
    if (s3.status === 'fulfilled' && s3.value.ok) {
      const b = s3.value.buckets;
      say(`  ✓ R2 凭证有效（ListBuckets 200，${b.length} 个桶${b.length ? `：${b.join(' / ')}` : ''}）`);
    } else {
      bad = true;
      const why = s3.status === 'fulfilled' ? `HTTP ${s3.value.status} ${s3.value.body.slice(0, 200)}` : s3.reason.message;
      warn(`  ✗ R2 凭证验活失败：${why}`);
    }
    if (bad) {
      warn('');
      warn('验活失败，未写入。修正后重跑，或加 --offline 只做形状校验（不推荐跳过）。');
      process.exit(2);
    }
  }

  const cwd = resolve(process.cwd());
  const underCwd = OPT.dest === cwd || OPT.dest.startsWith(cwd + sep);
  const repo = inGitRepo(OPT.dest);
  if ((repo || underCwd) && !OPT.allowRepo) {
    warn('');
    warn(`拒写：落点 ${OPT.dest} 在${repo ? ` git 仓库 ${repo}` : '当前项目目录'}里，凭证可能被打包/同步/提交出去。`);
    warn(`换落点（默认 ${DEFAULT_DEST}），或确实要写就加 --allow-repo。`);
    process.exit(1);
  }

  const { dir, size } = writeSecretFile(OPT.dest, cred);
  const st = statSync(OPT.dest);
  say('');
  say(`已写入 ${OPT.dest}`);
  say(`  目录权限 ${(statSync(dir).mode & 0o777).toString(8)} / 文件权限 ${(st.mode & 0o777).toString(8)} / ${size} B`);
  say('  加载方式： set -a; . ~/.dsh/cloudflare/creds.env; set +a');
  say('  复查：     node scripts/cf-creds.mjs --check');
}

main().catch((e) => {
  warn(`出错了：${e.message}`);
  process.exit(1);
});
