# 随身宠物 · 硬件可行性与选型

调研日 2026-10-24｜单位：人民币｜"估算" = 无公开可核价，按 2026-10 淘宝/立创散件价给区间

## 0. 结论速览

| 形态 | 结论 | 一句话 |
|---|---|---|
| ESP32-S3 圆屏挂件 | **能做，推荐** | 全链路可控，散件 ¥150–260；唯一硬伤是续航 3–6h |
| Wear OS 手表 | **能但体验打折** | 麦克风只能前台取，必须"开 App 再说话"，做不成常驻待听 |
| 消费级智能音箱 | **不能做** | 小爱/天猫精灵/HomePod 均不向第三方开放原始音频流 |

推荐顺序：**挂件 → 手表（第二屏/快捷入口）→ 音箱（仅外放）**。

## 1. 形态 A：ESP32-S3 圆屏挂件（推荐）

### 1.1 BOM（单件小批量）

| 部件 | 型号 | 价格 | 依据 |
|---|---|---|---|
| 主控 | ESP32-S3-WROOM-1-N16R8（16MB Flash/8MB PSRAM） | 25–35 估算 | 立创散件 |
| 屏 | 1.28″ 圆屏 GC9A01 240×240 SPI 模块 | 18–30 估算 | 裸屏模块；带触摸 30–45 |
| 麦克风 | 双麦 + ES7210（4 通道 ADC，带参考通道） | 18–40 估算 | 单麦 INMP441 约 5/只，但**做不了 AEC** |
| 功放 | MAX98357A（I2S，3W） | 6–10 估算 | — |
| 喇叭 | 8Ω 2W 2030 腔体 | 5–10 估算 | — |
| 电池 | 3.7V 锂聚合物 1000mAh | 12–20 估算 | 500mAh 约 8–12 |
| 充电 | ETA6096/TP4056 + 保护板 | 3–8 估算 | 多数开发板已板载 |
| 电源 | 同步 Buck（如 TPS63020 类） | 2–5 估算 | — |
| PCB | 5 片打样摊单片 | 8–12 估算 | 嘉立创 |
| 外壳 | 3D 打印 / 注塑 | 15–40 打印；开模 ¥3000–8000 一次性 | 估算 |

**散件合计 ¥110–200；含外壳线材 ¥150–260。** 体积约 45×45×16mm、**45–60g**（估算，取决于电池）。

### 1.1-bis 整板：不打板的三条路（价格 2026-10-24 从官方页核到）

| 板子 | 官方价 | 屏 | 麦 | 喇叭 | xiaozhi 固件 | 适合 |
|---|---|---|---|---|---|---|
| [ESP32-S3 AI Smart Speaker](https://www.waveshare.com/esp32-s3-audio-board.htm) | **$15.99** ≈¥115 | 无（有 LCD 接口） | **双麦 ES7210 + 降噪/AEC** + ES8311 | 喇叭座 | ✅ `waveshare/esp32-s3-audio-board` | **先验证语音链路**，桌面裸板 |
| [ESP32-S3-Touch-LCD-1.85](https://www.waveshare.com/esp32-s3-touch-lcd-1.85.htm) | **$25.99** ≈¥190 | 1.85″ 圆屏 **360×360** 触摸 | 单麦（只有软件 AEC → 建议半双工） | 附 8Ω 2W 2030 | ✅ `waveshare/esp32-s3-touch-lcd-1.85` | **一体原型**：屏+麦+喇叭+充电+RTC+TF 全有 |
| [ESP32-S3-Touch-LCD-1.28](https://www.waveshare.com/esp32-s3-touch-lcd-1.28.htm) | $20.29–21.99 ≈¥147–160 | 1.28″ 圆屏 240×240 触摸 | ❌ 没有 | ❌ 没有（无编解码、无功放） | ❌ 无现成配置 | 只买屏/IMU/充电，麦和功放自己焊 |

⚠️ **更正**：网上常把 1.28 当"AI 语音板"卖，但按官方 [wiki 板载资源](https://www.waveshare.com/wiki/ESP32-S3-Touch-LCD-1.28)（ESP32-S3R2 + 16MB Flash + 2MB PSRAM + QMI8658 + ETA6096 + SH1.0 六脚排针）**它不含任何音频硬件**；做语音要外挂 I2S 麦（INMP441 ¥5 / ES7210 模组 ¥30–45）+ I2S 功放（MAX98357A ¥10–15）+ 喇叭，并自己写板级配置。省事就选上表前两行。

AMOLED 版更漂亮但更贵更费电（[AMOLED-1.8](https://www.waveshare.com/esp32-s3-touch-amoled-1.8.htm) $27.99）。

### 1.1-ter 采购入口

- 官方站（美元、可直邮、价格权威）：上面三条链接；资料 `https://www.waveshare.com/wiki/<型号>`
- 国内：微雪淘宝店 <https://waveshare.taobao.com>；立创商城 <https://www.szlcsc.com>（搜 `ES7210` / `MAX98357A` / `GC9A01` / `INMP441`）
- 散件关键词（淘宝/立创通用）：`GC9A01 1.28寸 圆屏 SPI`、`ES7210 双麦 模块`、`MAX98357A I2S 功放`、`INMP441`、`ESP32-S3-WROOM-1 N16R8`、`103450 1000mAh`
- 淘宝/立创有反爬，单品链接会烂，**用型号关键词搜最稳**；散件价是估算区间，上面三个整板价是页面实价。

### 1.2 续航（估算，按 3.7V）

常听待机（WiFi 保活 + 息屏）≈50–70mA；语音对话（WiFi 流 Opus + 屏亮 + 喇叭）≈170–220mA。
→ 500mAh ≈ **2.5–3.5h**；1000mAh ≈ **5–6h**；1500mAh ≈ 7–9h。**像素动画是耗电大户**：降到 15fps、背光 30%、语音时熄动画可省 20–30%。

### 1.3 AEC 回声消除怎么做（关键）

必须**硬件+软件配合**，不能用单麦凑：
1. 硬件：双麦 + 一路"播放参考"通道（ESP-SR 用 `MMNR` 四通道格式：麦、麦、空、参考）——[ESP-SR AFE 文档](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/audio_front_end/README.html)。
2. 软件：ESP32-S3 跑 ESP-SR AFE（AEC+NS+VAD+WakeNet），把功放前的数字信号回灌作参考。**参考必须在 DAC/功放之前取**，从喇叭后面录回来会延迟对不齐。
3. 结论：**单麦 → 只能半双工**（说完再听，体验明显打折）；**双麦+参考 → 可真全双工**，可边播边打断。

现成开源：[xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) 已支持 ESP-SR 唤醒词、Opus 流、WebSocket/MQTT+UDP，官方明确"AEC-capable 硬件可实时全双工"，板级配置在 `boards/` 下（实测 53 个目录、100+ 变体，光微雪一家就 44 个变体，含 AMOLED 全系与 1.85 圆屏）。**这是本项目最省力的起点**，不用从零写固件。同生态成品机（"小智 AI"类）淘宝 **约 ¥200–400**，比自己打样贵不了多少，适合先买一台验证交互再改自制（估算）。

## 2. 形态 B：Wear OS 手表

### 2.1 能不能后台拿麦克风：**不能**

Android 规定 `microphone` 前台服务类型**无法从后台启动**（`RECORD_AUDIO` 受"仅在使用中"限制），也不能由 BOOT_COMPLETED 拉起——[官方 FGS 服务类型文档](https://developer.android.com/develop/background-work/services/fgs/service-types)。含义：表盘/后台**不能常驻待听**，必须用户先打开 App（点图标或表盘快捷方式）才能录音。联网稍宽松（WorkManager/前台服务可跑），但进 Doze 会被掐。息屏后想继续录，只能申请 `phoneCall` 类走系统通话界面——那不是"宠物"，是"打电话"。常亮屏（AOD）第三方 App 只能进低功耗模式（约 1Hz 刷新），AOD 开着再录音掉电更快。

### 2.2 价格与上架成本（2026 可买）

- 三星 Galaxy Watch9 蓝牙版 40mm **¥2499**、44mm **¥2799**、LTE 44mm **¥3199**；Watch8 40mm ¥2299 起；Watch Ultra ¥4999（[三星中国官网](https://www.samsung.com.cn/watches/galaxy-watch/)，官网标价）。
- OPPO Watch X 系列：官方页不标价，**估算 ¥2299–2999**（[OPPO 商城](https://www.opposhop.cn/)）。
- TicWatch：国行渠道已边缘化，**大概率买不到/无保修**（估算），不建议。
- 上架：Play 开发者 **$25 一次性**（[官方](https://support.google.com/googleplay/android-developer/answer/6112435)）；但 2023-11-13 后注册的**个人账号还需 12 名测试者连续 14 天封闭测试**才能发正式版（[官方](https://support.google.com/googleplay/android-developer/answer/14151465)）——自己玩用侧载（adb）可完全绕过。

### 2.3 封闭系统为什么不行

华为 GT 系列是 RTOS（LiteOS/HarmonyOS Lite），无第三方 App 运行环境；小米 HyperOS 手表虽有小应用商店，但**无公开独立开发者通道**，麦克风/后台网络不对三方开放。二者都只能"被控"（推送通知、IoT 指令），不能当麦克风终端。

### 2.3.1 小米手表到底能不能用 ADB（2026-10 核官方规格页）

| 型号 | 系统 | 喇叭/麦 | ADB | 三方 App |
|---|---|---|---|---|
| **Xiaomi Watch 5**（当前最新，海外版） | **Wear OS by Google**（骁龙 W5 Gen1 + BES2800，2GB+32GB，930mAh） | **Speaker: Supported；Microphone: Supported；蓝牙通话：支持** | ✅ 设置→关于→连点版本号→开发者选项→无线调试，可 `adb install` | 可侧载任意 APK（Wear OS 生态） |
| **Xiaomi Watch S4 / S4 41mm**（国行线） | **Xiaomi HyperOS 2 / 3**（Vela 系 RTOS，非 Android） | Speaker: Supported；Microphone: 2 mics；蓝牙通话：支持 | ❌ 无 adbd，RTOS 上不存在这个通道 | 只有官方商店 + [Vela JS 快应用](https://iot.mi.com/vela/quickapp/)（类 Web 范式，有网络/音频接口；需开发者资质与官方分发，麦克风与后台常驻不由你控制） |
| **Xiaomi Watch 2**（2024） | **Wear OS by Google** | 内置麦克风 + 扬声器，可蓝牙通话 | ✅ 同上 | 可侧载任意 APK |

官方出处：[Watch 5 产品页](https://www.mi.com/global/product/xiaomi-watch-5/)（"Wear OS by Google"）、[Watch 5 specs](https://www.mi.com/global/product/xiaomi-watch-5/specs/)（Speaker/Microphone/蓝牙通话/骁龙 W5 Gen1/2GB+32GB/930mAh）、[S4 specs](https://www.mi.com/global/product/xiaomi-watch-s4/specs/)（HyperOS 2）、[S4 41mm specs](https://www.mi.com/global/product/xiaomi-watch-s4-41mm/specs/)（HyperOS 3）、[Watch 2 产品页](https://www.mi.com/global/product/xiaomi-watch-2/)。⚠️ **国行版 Watch 5 的系统我抓不到**（mi.com 中国站全站 JS 渲染，curl 只回 27 字节；搜索引擎在本机被挡），按 Watch 2 的先例"海外 Wear OS / 国行 HyperOS"分开，**要跑自己 APK 就认海外版**。

**为什么"HyperOS"一词不能一概而论**：手机/平板上的 HyperOS 是 Android(AOSP) 基底，有 adb；手表/手环上的 HyperOS 是 **Vela**，而 Vela 官方定义是["小米基于开源实时操作系统 **NuttX** 打造的物联网嵌入式软件平台"](https://iot.mi.com/vela/)（NuttX = RTOS，不是 Linux/Android）。同名不同内核，判据：看设置里有没有"开发者选项/无线调试"、能不能装 APK。

### 2.3.2 其他品牌：谁能跑自己的代码

| 平台 | 代表机型 | 官方开发路径 | 能拿到麦克风？ | 结论 |
|---|---|---|---|---|
| **Wear OS**（Android 基底） | 三星 Galaxy Watch 系列、Google Pixel Watch 系列、OPPO Watch X 系列、OnePlus Watch、TicWatch、Xiaomi Watch 5/2 海外版 | Android Studio + `adb install`，或无线调试 | ✅ 但仅**前台/使用中**（见下） | 唯一现实可做"按一下说一句" |
| **watchOS** | Apple Watch | Xcode + WatchKit/SwiftUI，`AVAudioRecorder`，需 Apple Developer（$99/年） | ✅ 需 `WKExtendedRuntimeSession` 前台会话 | 能做，但贵、审核严、待听不可能 |
| **HarmonyOS 手表** | 华为 Watch 4/5、GT 5 | DevEco Studio（ArkTS/JS 卡片），需华为开发者资质 | ⚠️ 部分 API，未核实 | 不建议当主路径 |
| **Zepp OS** | Amazfit（Balance/T-Rex 等） | Zeus CLI，JS 小程序 | ⚠️ 能力弱，未核实 | 玩具级 |
| **Garmin Connect IQ** | Venu / Forerunner | Monkey C，联网经手机代理 | ❌ 无原始麦克风 API | 不能做语音终端 |
| **RTOS 封闭** | 小米 HyperOS 表、华为 GT RTOS 款、荣耀手表 | 仅厂商生态 | ❌ | 只能被控 |

**所有 Wear OS/Android 表的硬上限**（不是权限没开，是平台规则）：`RECORD_AUDIO` 受 while-in-use 限制——**不能在应用处于后台时创建麦克风前台服务，也不能从 `BOOT_COMPLETED` 拉起**（[Android FGS 文档](https://developer.android.com/develop/background-work/services/fgs/service-types) 原文，仅少数豁免）。所以手表永远做不到"开机即待听"，形态只能是"用户手势触发"。

**按侧键触发反而更对**：按键是明确的用户手势，正好绕开后台上限，也符合"宠物被叫醒才说话"的产品感。但它只是入口，采集仍在手机/板子上更稳。

### 2.4 结论

**能做，但体验打折**：定位应是"宠物 App + 蓝牙音频外设"，用户抬腕→点开→说话，**首字延迟 1–2s**，且亮屏+AOD 常开时手表本身 1 天多点就没电。它适合做"随身第二屏 + 快捷语音入口"，不适合做常驻伴侣。**更聪明的用法：手表只做遥控/显示，真正采集用手机（手机本来就因路由需求常开）**。

## 3. 形态 C：智能音箱

### 3.1 消费级音箱：**不能**

- **HomePod / HomePod mini**：只跑 Siri + HomeKit + Apple Music，**没有第三方 App 平台**（[Apple 官网](https://www.apple.com.cn/homepod/) 全站无 App Store/开发入口）。只能当 AirPlay 2 播放端。
- **天猫精灵**：开放平台给的是"技能应用接入（云端技能）、IoT 设备接入、集成其 SDK/模组"三类（[天猫精灵开放平台](https://www.aligenie.com/)），**没有把音箱麦克风原始音频流交给第三方的接口**；你要拿麦就得买它的模组自己做设备。
- **小爱同学**：公开入口只剩 [小米 IoT 开发者平台](https://iot.mi.com/)（设备接入/被控），同样无实时音频流出。
- 共同点：语音链路由厂商闭环，第三方最多"被 ASR 结果触发"，做不了实时语音对话机器人。

### 3.2 替代方案

1. **蓝牙 A2DP 音箱（只放音）**：能做，但 ESP32-S3 **只有 BLE 5，没有 Classic BR/EDR**，做不了 A2DP/HFP 主机——[ESP-IDF S3 蓝牙章节](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-reference/bluetooth/index.html) 只有 BLE/NimBLE/Mesh，无 A2DP/HFP 页面。要蓝牙音频得换 ESP32（原版）或让手机转发。
2. **AirPlay / DLNA 接收端**：DLNA 开放、可收可做，但**只能放音不能收音**；AirPlay 2 接收端需 Apple MFi 认证（费用/审核不公开，估算）。
3. **ESP32 自制音箱（推荐这条）**：同一套挂件固件 + 大喇叭 + 常供电，桌面形态 0 学习成本。**这是唯一"也是音箱、也是宠物"的路**。

## 3.3 「连手机蓝牙、手机当路由」到底行不行

| 方式 | 可行 | 说明 |
|---|---|---|
| 挂件 ↔ 手机 BLE（GATT 桥） ↔ PC | ⚠️ 技术上可行 | ESP32 只做 BLE，手机侧**必须跑一个 App**做 BLE↔TCP 桥：Web Bluetooth 不行（Android 仅 Chrome、必须用户手势触发、不能后台常驻；**iOS Safari 完全不支持**）。BLE 链路单向 30–80ms【估算】、带宽余量小，且手机 App 要自己写/维护。 |
| 挂件 ↔ **手机热点 Wi-Fi** ↔ PC | ✅ **推荐** | 手机开热点就等于"路由器"，ESP32 连 2.4G、PC 也连上（或 PC 本来就是手机热点成员）。零额外 App、Wi-Fi 直连延迟 10–30ms、带宽够 Opus 富余。出门在外一样成立。 |
| 挂件 ↔ 家里 Wi-Fi ↔ PC | ✅ 最省事 | 在家直接用，不需要手机参与。 |
| 挂件当手机蓝牙音箱（A2DP） | ❌ | S3 无 Classic BR/EDR，做不了 A2DP/HFP。 |

**结论：要"手机负责路由"，就让它开热点，别让它做 BLE 桥。** BLE 留给配网（SmartConfig/BLE Provisioning）和"低功耗唤醒后短暂连一下"这种场景。

## 4. 三形态对比

| 维度 | 挂件 ESP32-S3 | Wear OS 手表 | 消费级音箱 |
|---|---|---|---|
| 成本 | ¥150–260（整板原型 ¥115–190） | ¥2300–3200 | ¥200–1000（买了也用不了） |
| 端到端延迟 | 1.2–1.5s（PC 侧实测 1.2–1.4s + 板端 30–60ms） | 1–2s | — |
| 续航 | 3–6h | 1–1.5 天 | 常供电 |
| 开发量 | 中（固件+外壳）；复用 xiaozhi 可减半 | 低（纯 App） | 不可行 |
| 风险 | 续航 / 单麦 AEC 差 | 后台麦克风被系统限制、厂商系统更新 | 封闭，无解 |

**最终建议（已核价后的买法）**：
1. **先买 $15.99 的 ESP32-S3 AI Smart Speaker 板**（双麦 ES7210 + AEC + ES8311），把「ESP32 ↔ 网关的 Opus 实时语音」跑通，不涉及屏幕；这是全项目唯一没实测的关键项。
2. 语音通了再上 **$25.99 的 Touch-LCD-1.85 圆屏板**（屏+麦+喇叭+充电+RTC 一体），做"宠物外观"；单麦只能半双工，要全双工就照第 1 步的双麦方案自己打板（散件 ¥150–260）。
3. 手机当**热点路由**（不是 BLE 桥）；手表留作 V2 的"第二屏"，不要指望它待听。

## 5. 待核实（标注不确定）

- 立创/淘宝散件价被 WAF 拦截无法直接抓取，BOM 为估算；下单前请以实际询价为准。
- OPPO Watch X 官方未标价；Galaxy Watch9 为官网价，促销期会低 10–20%。
- AirPlay 2 的 MFi 具体费用与门槛未公开。
- 续航数字基于典型电流假设，实测需样板验证（建议首版就加 INA219 测功耗）。
