# 悬浮窗任务气泡的尺寸契约

气泡（`#bubble`）是悬浮窗里唯一一块**布局尺寸不许跟文字走**的区域。它同时决定三件容易被连点放大的事：

1. 卡片本身的高度：任何长度的回复都占同一块，卡片不会随字数长高；
2. 舞台缩放：`--shift` / `--shrink` 只由窗口高度和固定的卡片高度算出，跟字数无关；
3. 小人位置：连点时小人不会因为上一句长一句短忽大忽小。

## 三个数字

| 量 | 值 | 出处 |
| --- | --- | --- |
| 卡片高度 | `68px` | `android/app/src/main/assets/pet/template.html` 的 `#bubble { height }` |
| 同一常量（JS 侧） | `const bubH = 68` | `android/app/src/main/assets/pet/boot.js` 的 `say()` |
| 文本预算 | 90 字（超出截断成 89 字 + `…`） | 同上 |

`68 = 3 行 × 17.4 + padding 上下 12 + 边框 2 + 1.8 余量`。
`index.html` 是 `scripts/gen-pet-asset.mjs` 的生成物，改它会被下一次 `assembleRelease`（`preBuild` → `genPetAsset`）覆盖 —— 要改就改 `template.html` 和 `boot.js`，两处必须一起改。

## 为什么是 68 而不是 62

原来写死 62，可用内容高度只有 `62 − 12 − 2 = 48px`；90 字上限的回复在手机宽度（462 逻辑宽 → 内容宽 430）下正好 3 行 = `52.2px`，
第三行底部被 `overflow:hidden` 切掉约 4px。`-webkit-line-clamp:3` 在这种情况下不生效，因为盒子先裁掉了。

实测（同一份生成页面，430px 内容宽）：

| 文本 | 文本自然高度 | 卡片 computed height | 卡片可用内容高 |
| --- | --- | --- | --- |
| 9 字（1 行） | 17.4px | 68px | 54px |
| 64 字（2 行） | 34.8px | 68px | 54px |
| 89 字（3 行） | 52.2px | 68px | 54px |

## 系统字号

`FloatingPetService` 给气泡 WebView 设了 `settings.textZoom = 100`。
不设的话，用户把系统字号调到 1.15 倍，12px 会按 13.8px 排版，3 行变 `60px`、卡片还是 68，就会重新开始切字。

## 回归检查

改了气泡之后跑一次真机确认：

- `logcat --pid=<pid>` 里连点 3 下只有一句 `提示收口：… 只回执`（不走新的一轮）；
- 气泡出现期间悬浮窗顶部有一段约 70px 的暗色横带，气泡隐藏后同一批行回到壁纸色；
- `/pet-voice/api/update` 的 `versionCode` / `versionName` / `sha256` 跟刚装的包一致。
