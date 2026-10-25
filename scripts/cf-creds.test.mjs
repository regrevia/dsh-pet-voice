#!/usr/bin/env node
/**
 * scripts/cf-creds.mjs 的自测（全离线，不碰网络、不碰真凭证）。
 *   node scripts/cf-creds.test.mjs
 * 覆盖：中/英标签解析、形状校验、端点一致性、失败不落盘、权限、仓库内拒写、--check、掩码不泄露。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./cf-creds.mjs', import.meta.url).pathname;
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const AK = 'ABCDEF0123456789ABCDEF0123456789';
const SK = 'a'.repeat(32) + 'b'.repeat(32);
const TOKEN = 'Zx9' + 'q'.repeat(34) + '_-Ab';
const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function run(args, stdin = '') {
  const r = spawnSync('node', [SCRIPT, ...args], { input: stdin, encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const cnPaste = `帐户 ID
${ACCOUNT}

重要：立即复制您的令牌
您的 API 令牌
${TOKEN}

请将这些 S3 兼容凭证与 R2 API 或任何 S3 客户端搭配使用。
访问密钥 ID
${AK}

秘密访问密钥
${SK}

S3 API 端点
${ENDPOINT}
`;

const enPaste = [
  'Account ID: ' + ACCOUNT,
  'API Token: ' + TOKEN,
  'Access Key ID: ' + AK,
  'Secret Access Key: ' + SK,
  'S3 endpoint: ' + ENDPOINT,
].join('\n');

const base = mkdtempSync(join(tmpdir(), 'cfcreds-'));
const dest = join(base, 'cloudflare', 'creds.env');

console.log('1. 中文标签粘贴（--offline）');
{
  const r = run(['--offline', '--dest', dest], cnPaste);
  ok('退出码 0', r.code === 0, `code=${r.code} ${r.err.trim().slice(0, 200)}`);
  ok('文件已写', existsSync(dest));
  const txt = readFileSync(dest, 'utf8');
  ok('五个字段齐全', ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT'].every((k) => txt.includes(`export ${k}=`)));
  ok('文件权限 600', (statSync(dest).mode & 0o777) === 0o600, (statSync(dest).mode & 0o777).toString(8));
  ok('目录权限 700', (statSync(join(base, 'cloudflare')).mode & 0o777) === 0o700, (statSync(join(base, 'cloudflare')).mode & 0o777).toString(8));
  ok('stdout 不含秘密', !r.out.includes(SK) && !r.out.includes(TOKEN) && !r.out.includes(AK));
  ok('stdout 只有掩码', r.out.includes('…'));
}

console.log('2. 英文标签粘贴（覆盖写入）');
{
  const r = run(['--offline', '--dest', dest], enPaste);
  ok('退出码 0', r.code === 0, `code=${r.code} ${r.err.trim().slice(0, 200)}`);
  ok('AK 解析正确', readFileSync(dest, 'utf8').includes(`R2_ACCESS_KEY_ID=${AK}`));
  ok('账户与 AK 未混淆', readFileSync(dest, 'utf8').includes(`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}`));
}

console.log('3. 缺秘密访问密钥 → 拒写');
{
  const d2 = join(base, 'missing', 'creds.env');
  const r = run(['--offline', '--dest', d2], enPaste.replace(`Secret Access Key: ${SK}`, ''));
  ok('退出码 1', r.code === 1, `code=${r.code}`);
  ok('没有落盘', !existsSync(d2));
  ok('指出了缺哪项', /秘密访问密钥|Secret Access Key/.test(r.err), r.err.trim().slice(0, 160));
}

console.log('4. 端点与帐户 ID 不一致 → 拒写');
{
  const d3 = join(base, 'mismatch', 'creds.env');
  const r = run(['--offline', '--dest', d3], enPaste.replace(ENDPOINT, 'https://ffffffffffffffffffffffffffffffff.r2.cloudflarestorage.com'));
  ok('退出码 1', r.code === 1, `code=${r.code}`);
  ok('没有落盘', !existsSync(d3));
  ok('报端点不一致', /不一致/.test(r.err), r.err.trim().slice(0, 160));
}

console.log('5. 端点缺失 → 由帐户 ID 推导');
{
  const d4 = join(base, 'derive', 'creds.env');
  const r = run(['--offline', '--dest', d4], enPaste.replace(`S3 endpoint: ${ENDPOINT}`, ''));
  ok('退出码 0', r.code === 0, `code=${r.code} ${r.err.trim().slice(0, 200)}`);
  ok('推导出正确端点', existsSync(d4) && readFileSync(d4, 'utf8').includes(`R2_ENDPOINT=${ENDPOINT}`));
}

console.log('6. 幂等：重复跑不叠加、不留临时文件');
{
  const r = run(['--offline', '--dest', dest], cnPaste);
  const txt = readFileSync(dest, 'utf8');
  ok('退出码 0', r.code === 0);
  ok('只有一个 ACCOUNT 行', (txt.match(/CLOUDFLARE_ACCOUNT_ID=/g) || []).length === 1);
}

console.log('7. 落点在 git 仓库内 → 拒写');
{
  const inRepo = join(process.cwd(), '.cf-creds-should-not-exist.env');
  const r = run(['--offline', '--dest', inRepo], enPaste);
  ok('退出码 1', r.code === 1, `code=${r.code}`);
  ok('仓库里没有生成文件', !existsSync(inRepo));
  ok('提示了原因', /拒写/.test(r.err), r.err.trim().slice(0, 160));
}

console.log('8. --check --offline 校验已存文件');
{
  const r = run(['--check', '--offline', '--dest', dest]);
  ok('退出码 0', r.code === 0, `code=${r.code} ${r.err.trim().slice(0, 200)}`);
  ok('打印掩码', r.out.includes('…'));
  ok('不泄露秘密', !r.out.includes(SK) && !r.out.includes(TOKEN));
}

console.log('9. --check 对不存在的文件');
{
  const r = run(['--check', '--offline', '--dest', join(base, 'nope.env')]);
  ok('退出码 1', r.code === 1);
}

console.log('10. 空输入');
{
  const r = run(['--offline', '--dest', join(base, 'empty.env')], '   \n');
  ok('退出码 1', r.code === 1);
  ok('没有落盘', !existsSync(join(base, 'empty.env')));
}

rmSync(base, { recursive: true, force: true });
console.log('');
console.log(`cf-creds 自测：${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  fails.forEach((f) => console.log(`  失败：${f}`));
  process.exit(1);
}
