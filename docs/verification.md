# 怎么验（在自己的机器上跑一遍）

这份文档只写**能复现的检查**：每条给出命令、看什么、合格标准。数字都来自本机实测，
你换个环境跑出来会不一样（机器不同、网络不同），但「该看到什么」是一样的。

## 1. 只用轮询时能不能收到回复

面板把传输方式锁成 `只用轮询` 后，发一句话，在 logcat 里应该看到这四行（`adb logcat | grep -E "PetTurn|PetLatency"`）：

```
PetLatency: +460ms transport panel=poll
PetTurn : transport forced poll by panel
PetLatency: +460ms pollSent baseline cursor=-1
PetLatency: +963ms pollReturned http=200 cursor=0
```

合格标准：`pollReturned http=200`，随后出现 `event start` / `event final`，屏幕上气泡出全文。

> 附带一句：`event final … feeder=sse` 在纯轮询轮次里也会打印。那是诊断标签写错（delta 分支两条通道共用，先跑到的会把自己标成 `sse`），不代表真开了 SSE。纯轮询这条分支在 `PetTurn.kt` 里于 `client.openStream()` 之前就 return 了。

## 2. 说完多久收尾（尾静音 1s）

判定逻辑在 `VadGate`（纯逻辑，不碰麦克风），真机日志在 `PetVad`：

```bash
android/gradlew -p android :app:testDebugUnitTest --tests 'com.whale.pet.VadGateTest'
adb logcat | grep PetVad   # vad 1600ms 人声600ms 尾静音1000ms stopped=TAIL_SILENCE ...
```

`VadGateTest` 用合成音量喂进去，断言的是毫秒本身：

| 场景 | 最后一个人声帧之后 | 总时长 | 结论 |
| --- | --- | --- | --- |
| 说 600ms 然后住嘴 | 正好 1000ms 收尾 | 1600ms | 不是等满 6s |
| 说 800ms / 说 4000ms | 都是 1000ms | 1800ms / 5000ms | 跟着语音结束点走 |
| 只「嗯」200ms | 不算开口 | 6000ms 放弃 | 噪声不触发整轮 |
| 一直说不停 | — | 12000ms 上限 | 不会无限录 |

`stopped=` 三个值对应三条收尾路径：`TAIL_SILENCE`（说完了）/ `MAX_LEN`（说太久）/ `NO_SPEECH`（没人说话）。

## 3. 八套衣服的动画都不卡住

`scripts/` 之外的两个小工具：`measure-anim.py`（录屏测）和下面这条更省事的等价检查——
每隔约 1 秒截一张图，只比小人在屏幕上的那块区域（300×520，左上角 `720,1370`），算变化像素占比。

```bash
for i in 0 1 2 3 4; do adb exec-out screencap -p > /tmp/s$i.png; done
# 用任意图像工具裁 300x520+720+1370 后两两比差；相邻两张差异 ≥0.5% 就算在动
```

本机实测（`sailor` 起逐套切，模拟器 1080×2340）：

| 衣服 | 相邻帧变化 | 结论 |
| --- | --- | --- |
| sailor | 31.9 / 29.2 / 26.6 / 16.5 % | 在动 |
| maid | 34.5 / 64.0 / 64.6 / 18.0 % | 在动 |
| casual | 63.4 / 32.3 / 64.0 / 19.5 % | 在动 |
| winter | 31.9 / 31.2 / 30.6 / 21.1 % | 在动 |
| princess | 37.1 / 63.7 / 32.9 / 64.0 % | 在动 |
| researcher | 27.4 / 33.1 / 29.3 / 23.3 % | 在动 |
| witch | 31.7 / 31.7 / 29.2 / 21.7 % | 在动 |
| pajamas | 30.9 / 25.8 / 25.8 / 22.0 % | 在动 |

静止（卡帧）会出现连续两张 0.0 %，看到就该报 issue。

## 4. 自带测试

```bash
node --test plugins/dsh-pet-voice/test/*.test.mjs   # 10/10
bash scripts/verify.sh                              # 19/19
```

Android 侧单测（需要 SDK）：

```bash
android/gradlew -p android :app:testDebugUnitTest   # 17/17
```

## 5. 出包与签名

```bash
android/gradlew -p android :app:assembleRelease
shasum -a 256 android/app/build/outputs/apk/release/app-release.apk
```

自签证书指纹固定为 `8a2cc532…27ef`，换机器出包必须沿用同一个 keystore，否则覆盖安装会失败（见 [real-device-install.md](real-device-install.md)）。
