# 悬浮窗尺寸固定：证据与闸门

用户的原话是「悬浮窗任务大小保持固定，面对多点击场景也要正常显示动作」。这条不是审美问题，是**可回归的工程约束**，所以拆成三层分别钉住。

## 三层约束各钉什么

| 层 | 位置 | 钉住的东西 |
| --- | --- | --- |
| 系统窗口 | `FloatingPetService.kt:594-595`（拖动分支 `:724-725`） | 窗口宽高只由 `dp(size)` / `dp(size + 48)` 决定，跟回复字数无关 |
| 卡片 | `assets/pet/template.html`（生成 `index.html`）里 `#bubble` 固定 `height: 68px` + `#bubbleText` `-webkit-line-clamp: 3` | 三行以内高度不变，超出截断（68px 见 `docs/pet-bubble-contract.md`） |
| 让位/缩放 | 同一文件 `shiftPx` / `shrink` 只由 `window.innerHeight` 算出 | 气泡出现时小人等比缩小，收起时回去，中间只过一次 `.18s` 过渡 |

关键点：`--shift` / `--shrink` **不能**按气泡实测高度（`bubble.offsetHeight`）算。一旦接回实测高度，长回复就会让小人忽大忽小——这就是「不协调」的来源。`scripts/pet-size-check.sh` 专门检查这一条。

## 复跑闸门

```bash
scripts/pet-size-check.sh                    # 量当前前台 + 校验已出包 APK 里的 asset
scripts/pet-size-check.sh --n 24 --step 0.16 # 连点期间连采
```

判定：窗口 frame 的 `size=` 在所有采样里必须**完全一致**；`template.html` 的 `#bubble height` 与 `boot.js` 的 `const bubH` 必须相等（脚本现读现值，不写死数字）；APK 内 asset 必须含 `height: <N>px`、`const bubH = <N>`、`line-clamp: 3`，且不含 `bubble.offsetHeight`。任一不满足 exit 1。

## 已测数据（build 132 / 0.9.62）

- 待机、提示、思考、回复四态连采：窗口恒为 `594x462`。
- 10 连点（间隔 200 ms）+ 采样窗口 `winwatch.py --n 26 --step 0.16`：**26/26 帧 `size=594x462`**。
- 像素级：连点/回复期间以空闲帧为基准做差分，变化区稳定在角色身上（约 350×440），卡片区不随字数扩张；这点只作旁证，权威判据是上一条的窗口 frame。
- APK 内容核对：`assets/pet/index.html` 内含固定卡片约束（`unzip -p app-release.apk assets/pet/index.html`）。

## 已知局限

- WebView 无障碍树很慢（0.5–5 s 一次），且经常读不到 `#stage`，所以**不用 `adb_anim` 量卡片**，一律走 `dumpsys window` 的 frame（毫秒级、稳定）。
- release 包没开 `WebView.setWebContentsDebuggingEnabled`，`adb_web` 读不到 DOM；要量化卡片内动画只能用截图差分。

## 闸门自查记录（2026-10-28，0.9.68）

脚本原来把 `const bubH = 62` 写死在判据里，卡片定高从 62 改到 68 之后就一直报 `✗ APK asset 缺固定尺寸约束`——闸门自己先过期了。现在改成从源码现读：

```
· 窗口尺寸 12/12 次一致：594x462
· 源码两处高度一致：68px
· APK asset 含固定尺寸约束：const bubH = 68
· APK asset 含固定尺寸约束：height: 68px
· APK asset 含固定尺寸约束：line-clamp: 3
· 通过：窗口恒定 + 卡片固定
```

`§ 出包前` 的用法不变，仍然是在装好新包、悬浮窗活着的状态下跑一次。
