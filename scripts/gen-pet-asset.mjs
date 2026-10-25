/**
 * 生成悬浮窗用的单文件页面：把 android/app/src/main/assets/pet/anim-pet.js（视频版形象引擎）
 * 与 assets/pet/boot.js（渲染桥）内联进 assets/pet/index.html。
 *
 * 为什么内联：悬浮窗走 file:///android_asset/，ES module 的 import 在 file:// 下会被
 * 当成跨域直接拒绝（"Cross origin requests are only supported for protocol schemes"）。
 * 内联成经典 <script> 既绕开这个限制，也省掉两次资源请求，冷启动更快。
 *
 * 用法：node scripts/gen-pet-asset.mjs
 * 改了插件里的 pet.js 之后必须重跑，然后重新构建 APK。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const petPath = join(root, 'android/app/src/main/assets/pet/anim-pet.js')
const bootPath = join(root, 'android/app/src/main/assets/pet/boot.js')
const tplPath = join(root, 'android/app/src/main/assets/pet/template.html')
const outPath = join(root, 'android/app/src/main/assets/pet/index.html')

/**
 * Aster 立绘清单：page 走 file://，不能 fetch/import JSON，只能在生成时内联。
 * 清单由 scripts/build-aster-assets.py 产出；还没生成就留 null，引擎会用回视频素材。
 */
let asterJson = 'null'
try {
  const raw = readFileSync(join(root, 'android/app/src/main/assets/aster/manifest.json'), 'utf8')
  asterJson = JSON.stringify(JSON.parse(raw))
  const n = JSON.parse(raw).outfits.length
  console.log(`  内联 Aster 立绘清单：${n} 套`)
} catch (e) {
  console.log('  没有 Aster 立绘清单（先跑 scripts/build-aster-assets.py），页面回落视频素材')
}

/**
 * Aster Studio v3 三动作清单（idle/talk/wave）：同样只能生成时内联。
 * 由 scripts/build-aster-v3.py 产出；没有就留 null，引擎退老的 24 帧立绘或视频素材。
 */
let v3Json = 'null'
try {
  const raw = readFileSync(join(root, 'android/app/src/main/assets/aster/v3/manifest.json'), 'utf8')
  v3Json = JSON.stringify(JSON.parse(raw))
  const m = JSON.parse(raw)
  console.log(`  内联 Aster v3 三动作清单：${m.outfits.length} 套 / ${m.fps}fps`)
} catch (e) {
  console.log('  没有 Aster v3 三动作清单（先跑 scripts/build-aster-v3.py），页面回落老立绘')
}

const idleSrc = readFileSync(join(root, 'android/app/src/main/assets/pet/idle.js'), 'utf8')
  .replace(/^export function /gm, 'function ')
if (/^\s*(import|export) /m.test(idleSrc)) throw new Error('idle.js 还有 import/export，内联会语法错误')

const petSrc = readFileSync(petPath, 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export function createPet/m, 'function createPet')
if (/^\s*(import|export) /m.test(petSrc)) throw new Error('pet.js 还有 import/export，内联会语法错误')

const bootSrc = readFileSync(bootPath, 'utf8').replace(/^import .*$/gm, '')
if (/^\s*(import|export) /m.test(bootSrc)) throw new Error('boot.js 还有 import/export')

const template = readFileSync(tplPath, 'utf8')
const scriptTag = /<script type="module" src="\.\/boot\.js"><\/script>/
if (!scriptTag.test(template)) {
  throw new Error('index.html 模板里找不到 module 脚本标签，模板被改过了')
}

const inlined = template.replace(
  scriptTag,
  `<script>\n/* ===== Aster 立绘清单（生成时内联，勿手改） ===== */\nwindow.ASTER_MANIFEST = ${asterJson}\n/* ===== Aster v3 三动作清单（生成时内联，勿手改） ===== */\nwindow.ASTER_V3 = ${v3Json}\n/* ===== idle.js：待机小动作的纯逻辑 ===== */\n${idleSrc}\n/* ===== pet.js：来自 android/app/src/main/assets/pet/anim-pet.js（勿手改，改后重跑本脚本） ===== */\n${petSrc}\n/* ===== boot.js：渲染桥 ===== */\n${bootSrc}\n</script>`,
)

writeFileSync(outPath, inlined)
console.log(`已生成 ${outPath}`)
console.log(`  内联 idle.js ${idleSrc.length} + pet.js ${petSrc.length} 字符 + boot.js ${bootSrc.length} 字符 = ${inlined.length} 字节页面`)
