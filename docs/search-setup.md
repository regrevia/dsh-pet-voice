# 搜索能力改造（DSH 端）

> 记录时间：2026-10-24（晚更新）。目的：让会话里的 `web_search` / `web_fetch` 不再依赖单一 DeepSeek 官方通道，
> 也不再用「猜」的方式给结论。
> 本机状态：**已生效**——`web_search` / `web_fetch` 走 `dsh-web-search-free` 正式链，
> 顺序 **TinyFish → AnySearch**，`searchStrategy: fallback`（§2.1）。
> **两把 Key 都已就位**（2026-10-24 晚）：TinyFish 打头、AnySearch 兜底，限速或报错时同一请求内立刻切换（§2.1）。
> Key 只存在 `~/.dsh/profiles/desktop/cordis.patch.yml`（`chmod 600`）。早前为绕开匿名额度写的本机插件 `dsh-web-anysearch-anon`
> 已**下线**，文件保留作备用（§2.2）。

## 1. 之前为什么搜不到

- 内置 `web_search` 走 `ctx.web` 的 `searchProvider: deepseek-official`，每次搜索 = **一次完整的模型请求**
  （anthropic 格式带服务端 `web_search` 工具，60s 超时），凭据是 `DEEPSEEK_API_KEY`。
- 本机 `.credentials.yaml` 里那条 DeepSeek key 被上游拒（401），于是搜索直接失败，且不消耗任何可见日志。
- 结论：这不是网络问题，是**通道 + 凭据**问题。

## 2. 现在长什么样（三层，各自负责什么）

```
web_search / web_fetch
      │
      ├─ ① 正式链：dsh-web-search-free  →  providerOrder [tinyfish, anysearch]，searchStrategy fallback
      │      TinyFish 报 401/402/403/429、返回空结果或单次超 10 s → **同一请求内**立刻改走 AnySearch
      │      （任一引擎的 Key 为空 → 该引擎不可用；只剩一把就退化为单引擎，链路本身仍在）
      │
      └─ ② 备用（默认不挂载）：本机插件 dsh-web-anysearch-anon —— AnySearch 匿名/自带 Key 的最小实现
```

### 2.1 正式链：TinyFish 优先、AnySearch 兜底

`~/.dsh/profiles/desktop/cordis.patch.yml` 里 `- id: web-search-free`：

```yaml
- id: web-search-free
  config:
    providerOrder: [ tinyfish, anysearch ]
    searchStrategy: fallback
    anysearchApiKey: <你的 AnySearch Key>
    tinyfishApiKey: <你的 TinyFish Key>
```

- 顺序为什么是 TinyFish 在前：它有日期过滤（`after_date` / `before_date` / `recency_minutes` /
  `domain_type=news`，AnySearch 完全没有），独立评测事实查证 92.0%（§5.2），免费额度 12,000 次/天
  （AnySearch 1,000 次/天）；AnySearch 强在中文与官方文档命中（实测 11/11，§5.1），当兜底足够。
- `fallback`（插件默认）= 按顺序试，前一个报错/额度耗尽才用下一个，最省额度；`merge` 会 N 倍消耗额度，
  `race` 是同时发、取最快（不省钱，且经常是 AnySearch 先回，等于白烧 TinyFish 额度）。
- **限速切换有多快【实测 2026-10-24】**：不是「等下一次请求」，而是**同一次工具调用内**立刻换引擎。
  用一把假 Key 打 TinyFish 实测：`401` 在 **0.53 s** 内返回（`{"error":{"code":"INVALID_API_KEY"}}`），
  紧接着 AnySearch 出结果，整次 `web_search` 正常返回、会话无感。所以 TinyFish 被限速时，额外代价
  ≈ 一次失败往返 **0.3–0.6 s**，不是几十秒。
- 失败会「记住」：某个 `(引擎, Key)` 撞到 **401/402/403/429 或额度耗尽**就被挪到链尾——429 停 **2 分钟**，
  401/402/403 停 **30 分钟**，之后的请求不再重复撞它；成功一次即解除。
- 单次尝试有硬超时（搜索 10 s、抓取 20 s），所以「引擎卡住不返回」不会吃满整个工具预算，兜底一定有机会跑。
- 引擎 id 是 `anysearch` / `tinyfish`（不是 `serp`、不是 `baidu-qianfan`）。

### 2.2 已下线的本机插件 `dsh-web-anysearch-anon`（保留作备用）

背景：2026-10-24 本机出口 IP 的 AnySearch 匿名日额度被用尽（HTTP 402），而当时 `dsh-web-search-free`
只认「有 Key 的引擎」，于是临时写了这个零依赖 provider
（[plugins/dsh-web-anysearch-anon/index.mjs](../plugins/dsh-web-anysearch-anon/index.mjs)，
profile 副本 `~/.dsh/plugins/dsh-web-anysearch-anon/index.mjs`）先把 `web_search` 救回来。

它当时解决了两件事：

1. **匿名可用**：不带 `Authorization` 头即可调 `/v1/search` 与 `/v1/extract`，按出口 IP 计每日额度；
   `config.apiKey` 非空时两个端点自动改发 `Authorization: Bearer <key>`，代码不变。
2. **凭据泄漏**：上游 402 回包会自动发放账号凭据（`username=` / `password=` / `api_key=`）并原文塞进错误消息。
   已用 `redactSecrets()` 抹掉（伪造 402 回包单测：三个值都不再出现；带 Key 时请头也单测确认）。
   顺带说明：`web-search-free` 自己不会读错误体，只报 `HTTP 402`，所以正式链没有这个风险。

**2026-10-24 已下线**（不再挂在 profile 里），原因就是技术债：

- `web-search-free` 填上 AnySearch Key 后自己就可用了（`anysearchApiKey` 非空即视为该引擎可用），
  不需要第二个 provider 抢 `web` 行；
- 为绕「已 import 的模块不会重新执行」而加的 `?keyed=1` 热换壳，等于同一份文件挂两个实例 + 两条 `insert`，
  维护时很容易看错「到底哪个在跑」。

下线动作：删掉两条 `insert` 入口，`web` 行的 `searchProvider` / `fetchProvider` 改回 `web-search-free`。
改完**不需要重启**，但别指望「下一条就生效」——patch 由 loader 重载，实测有几十秒到几分钟的滞后
（见下面的 2026-10-24 观测）。要确定性，重启 App 再看。

需要时怎么再启用（只加一个入口，别同时挂两个实例）：

```yaml
- insert:
    - id: dsh-web-anysearch-anon
      name: "file://~/.dsh/plugins/dsh-web-anysearch-anon/index.mjs"
      config:
        apiKey: <你的 AnySearch Key>   # 留空 = 走匿名通道
```

启用后把 `web` 行两个值改成 `anysearch-anon` 即可。

**2026-10-24 实测到的热应用行为（比"热应用/不热应用"更细）**：

| 改动 | 是否立刻生效 | 证据 |
| --- | --- | --- |
| `anysearchApiKey` 值 | ✅ 秒级生效 | 写成假 Key 后下一条搜索立刻报 `anysearch (as_s…000): 401`，错误里的指纹就是刚写的值 |
| `providerOrder` 数组 | ❌ 未生效 | 收窄成 `[ anysearch ]` 后等 70 s 再搜，返回仍带日期（AnySearch 结果只有 `content/snippet/title/url` 四个字段、**没有日期**，带日期只可能是 TinyFish） |

结论：**改 Key 放心改，立刻生效；改链序（`providerOrder`）别指望热更新**——要换顺序就重启 App。改插件**代码**则必须换 ESM URL 或重启
（已 import 的模块不会重新执行）。Key 只放在
`~/.dsh/profiles/desktop/cordis.patch.yml`（`chmod 600`），**不进仓库**。

## 3. 免费引擎对比（2026-10-24 本机实测可达性）

| 引擎 | 免费额度 | 绑卡 | 本机网络 | 备注 |
| --- | --- | --- | --- | --- |
| **AnySearch** | **1,000 次/天**（学生/开发者认证后 **2,000**），20 QPS（匿名也计入每日额度） | 不需要 | ✅ www.anysearch.com 200 · ✅ api.anysearch.com 200 | 兜底位；中文/官方文档命中好（11/11），**无日期字段、无 freshness 过滤** |
| **TinyFish** | 搜索**免费 12,000 次/天**（官方文档口径），速率 30 次/分；抓取 150 url/分 · 1000 url/天 | 不需要（"No card required"，但要注册拿 Key） | ✅ tinyfish.ai 200 · ✅ api.search.tinyfish.ai 200 | **首选位**；独立评测事实查证 92.0%、2.62 s；**支持 `after_date` / `before_date` / `recency_minutes` 与 `domain_type=news`**（AnySearch 没有）；实测假 Key 的 401 在 0.53 s 返回，失败切换很快 |
| **Exa** | **$10/月 + $10 开机奖励（累积）**，约 2500 次 lite 搜索/月 | 不需要（Free 明确 "No payment method required"） | ✅ exa.ai 200 | 英文/技术内容强，独立评测事实查证第一（99.3%，付费档） |
| 百度千帆 | 每日免费额度（以控制台为准） | 需百度云账号 | ✅ baidubce.com | 只搜中文，中文时效最好 |
| 火山引擎（豆包搜索） | 500 次/月 | 需账号 | — | 只搜中文 |
| SearXNG | 自建实例，不限量 | 不需要 | 需自建 | key 框填实例地址（要开 json 输出） |
| Serping | 1000 次/账号（一次性，无需绑卡） | 不需要 | ✅ serpingapi.com 200 | 一次性额度 |
| Firecrawl | 1000 credits/月 | 需账号 | — | 搜索 2 credits/10 结果 |
| Tavily | 1000 credits/月 | 需要 | ❌ 官网 000 | 本机网络不可达，暂不可用 |
| Brave | $5/月额度 | **要绑卡** | ❌ 000 | 不推荐 |
| Jina | 新 key 送 10M tokens（一次性） | 不需要 | ❌ s.jina.ai 000 | 不可达 |

> 额度与可达性都可能变，改动前重新抓一次官网；「✅/❌」是本机 `curl` 于 2026-10-24 的实测结果。

## 4. Key 怎么拿、怎么填（TinyFish）

### 4.1 拿 TinyFish Key（免绑卡，约 1 分钟）

1. 打开 <https://agent.tinyfish.ai/sign-up>，用邮箱/GitHub 注册（**不需要信用卡**）。
2. 进控制台 <https://agent.tinyfish.ai/api-keys> → 新建 Key，复制出来的字符串（形如 `tf-…`）。
3. 免费额度：搜索 **12,000 次/天**（30 次/分）、抓取 150 url/分 · 1000 url/天；每日 00:00 UTC 重置。
   超限不是「封号」，是 429，正式链会立刻切 AnySearch（§2.1）。

### 4.2 交给 DSH 的两种方式

**A. 推荐：落文件，别进对话**（Key 不会出现在聊天记录、日志、我给你的任何引用里）

```bash
printf '%s' 'tf-你的key' > ~/.dsh/tinyfish.key && chmod 600 ~/.dsh/tinyfish.key
```

然后跟我说一句「放好了」。我会：
读这个文件 → 写进 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `web-search-free.config.tinyfishApiKey`
（该文件本就 `chmod 600`）→ **删掉 `~/.dsh/tinyfish.key`** → 立刻发一条真查询验证它在打头，再回报结果。

**B. 直接贴在聊天里**：能用，但 Key 会永久留在这次会话的记录里（导出/备份/分享都会被带上），
所以要贴就贴一次、之后去控制台轮换。日常不建议。

**C. 界面填**：设置 → 插件 → Web 搜索（`web-search-free`）→ `tinyfishApiKey` 输入框 → 「测试」。
效果等价，凭据存进 DSH 的凭据服务；优点是我不经手，缺点是不在版本化的 patch 里，换机器要重填。

### 4.3 填完怎么确认「真的是 TinyFish 在打头」

1. 发一条时间敏感查询（例如「小米 Watch 5 最新固件更新」）：TinyFish 有日期过滤，`sources[].publishedAt`
   会带上日期；AnySearch 没有日期字段，回包里不会出现 `publishedAt`。
2. 反向验证（我 2026-10-24 用过这招）：把 `anysearchApiKey` 临时注释掉、只留 `tinyfishApiKey`，
   再搜索——若回包变成 `All configured search providers failed (1 attempt): tinyfish (…): …`，
   说明 TinyFish 确实在链首被调用；恢复 AnySearch 那行即回到双引擎。
3. 强证据：TinyFish 被限速时，同一次查询仍能返回结果（只是慢 0.3–0.6 s），说明兜底真的接上了。

### 4.4 轮换 AnySearch Key（一条命令）

控制台新建 Key → **复制** → 在终端跑：

```bash
python3 ~/.dsh/bin/rotate-anysearch.py
```

它按顺序做五件事，任何一步不过就**不写文件**：

1. 读剪贴板、去掉空白；形状不像 Key（长度/字符集不符）直接退出
2. 拿新 Key 打一次 `POST https://api.anysearch.com/v1/search`（`Bearer`，`max_results:1`）
   —— 上游 401/422 或 `code != 0` 就退出，**旧的可用配置保持原样**
3. 备份成 `cordis.patch.yml.bak-<时间戳>`（600）
4. 只替换 `anysearchApiKey:` 这一行的值，写临时文件 → 校验 YAML entry 数没变 → 原子替换，权限 600
5. 打印掩码后的新 Key（`as_sk_…xyz`）与备份路径

脚本在 `~/.dsh/bin/rotate-anysearch.py`（700）。改完**不用重启**，loader 会重载配置（实测可能滞后
数十秒，急用就重启 App）；
确认没问题后去控制台把旧 Key 删掉。同一个 Key 再跑一次会直接说「无需更换」，不会重复写。

> 两把 Key 是分开的：`web-search-free` 读的是自己 `config` 里的 `anysearchApiKey` / `tinyfishApiKey`；
> AnySearch 侧在 <https://www.anysearch.com/console/api-keys> 申请/轮换。
> **2026-10-24 两把 Key 都进过会话记录**（AnySearch 那条本来还是上游 402 回包自动发的）——
> 已按 §4.4 轮换；以后 Key 只走「复制 → 脚本读剪贴板」这条路，不再在对话里出现。

**省钱提醒**：AnySearch 账号额度 1,000 次/天、学生/开发者认证后 2,000 次/天（匿名额度按 IP 另计，
本机 2026-10-24 已用完，见 §2.2）；
TinyFish 12,000 次/天，够用。正常对话一天十几到几十次搜索；批量抓取请走 `web_fetch` 或直接 curl，
不要拿 `web_search` 当爬虫。

### 4.5 密钥卫生：脱敏是一个被测试过的函数，不是手写的一行正则

**事故**：2026-10-24 我为了核对配置，临时写了 `sed 's/\(sk-[a-z]*\)….*/\1…(masked)/'`——它只按
**已脱敏的形态**（`sk-t…xyz`）去匹配，而文件里是明文，于是两把真 Key 原样进了会话记录。手写脱敏
这种"看着对"的写法，出错方式是静默的：不报错、不提示，直接把密钥打印出来。

**现在**：`~/.dsh/bin/mask.py`（700），脱敏逻辑固定在里面，自带 **18 例断言**（`--selftest` 全过）：

```bash
python3 ~/.dsh/bin/mask.py --show-config        # 看 profile 配置的 key 行（已脱敏，带长度与权限）
python3 ~/.dsh/bin/mask.py --selftest          # 18 例：前缀式/头部/键值/长串/幂等/误伤
python3 ~/.dsh/bin/mask.py --audit PATH...     # 审计"哪里还有明文"，默认只报真像密钥的
python3 ~/.dsh/bin/mask.py '<文本>'            # 过滤任意文本；也可以管道：cmd | mask.py
```

规则（宁多遮，不误露）：

1. 已知前缀一律遮：`as_sk_` `as_auto_` `sk-` `tf_` `ghp_` `xox*-` `AIza` `pk-lf-` `hf_`（带左边界，
   所以 `vosk-model-…` 不会被误判成 `sk-` 密钥）
2. `Authorization: Bearer …`、`X-API-Key: …`、`api_key=…`、`password=…` 这类键值：值一律遮
3. 长度 ≥32 的高熵串，仅在同行出现 key/token/secret/password 时遮（`--deep`）
4. 输出形态 `前缀4位…后3位(长度)`：**后 3 位足以人工核对是哪一把，但不构成泄露**；幂等，已遮的不再变形

**当前审计结果**（2026-10-24，默认模式）：仓库 `/tmp/pet-lab` **0 处**明文密钥；
profile 配置里 2 处（那是 Key 唯一该待的地方，`chmod 600`）。

> 以后任何"要看一眼配置"的场合，一律 `--show-config`，不要 `grep`/`sed` 直接打印。

## 5. 实测效果评估（这轮真的跑过，不是看官网介绍）

### 5.1 AnySearch：11 条真查询，`zone=cn`（那一轮走匿名通道，同一接口现在走账号 Key，返回结构相同）

| 指标 | 实测值 |
| --- | --- |
| 成功率 | **11/11**（全部 `code === 0`，无 429/402） |
| 单次服务端耗时 | **1.14 – 2.82 s**（`data.metadata.search_time_ms`） |
| 单次端到端耗时 | **1.34 – 3.39 s**（本机 curl） |
| 返回条数 | 固定 8 条（`max_results` 生效，上限 10） |
| 摘要质量 | 11/11 每条都带 `content` 字段，80–781 字；插件优先用 `content` 而非 `snippet` |
| 一手/官方源进前 3 | **11/11** |
| 明显噪声 | 1/11 的尾部出现中文 SEO 站（导航站、开户网），未进前 3 |

抽几个可复核的命中：

- 「小米澎湃OS MCP服务发布 审核」→ #1 `https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2308`，
  摘要直接引到「1~3个工作日内完成审核」，与官方页原文一致。
- 「Xiaomi Watch 5 Wear OS specifications」→ #1 `mi.com/global/product/xiaomi-watch-5/`，gsmarena 佐证
  「Android Wear OS 6 (Global)」——与我此前纠正过的结论一致。
- 「TinyFish search api benchmark accuracy」→ 直接找到独立评测
  [openbenchmarks.com/web-search](https://openbenchmarks.com/web-search)，即 §5.2 的数据来源。
- 「ESP32-S3 语音 AI 开发板 推荐」→ 微雪 ESP32-S3-AUDIO-Board、DFRobot 1.85 寸圆屏板、乐鑫 ESP-SR 文档，
  正好覆盖本项目 BOM 的候选板。

**已知短板（必须知道）**

1. **没有日期字段、没有 `freshness` 过滤**：响应里每条只有 `title/url/snippet/content`，没有 `publishedAt`。
   所以「最新 / 今年 / 当前版本」这类问题，排序里可能混进过时页面——实测「DeepSeek V4.1 发布时间」
   时，百度百科那条写「2026 年 6 月」，而官方 news 页写「2026 年 9 月 14 日 12:00 之后」，百科是爬旧的。
   → 时间敏感结论必须抓原文、看页面自带日期。
2. **尾部有中文 SEO 噪声**：商业/长尾词更容易带出来，前 3 名仍可用。
3. **只给 8–10 条**：深挖靠 `web_fetch` 或换 query 改写，不靠翻页。

### 5.2 TinyFish：用第三方独立评测的数（我没有 Key，未自测）

[openbenchmarks.com/web-search](https://openbenchmarks.com/web-search)（独立、开源、最后测量 2026-10-21，
13 家厂商、同一模型同一判官）事实查证任务（300 题）TinyFish 免费档：

| Accuracy | AR@1 | AR@5 | 延迟 | 每条摘要 tokens | 价格 |
| --- | --- | --- | --- | --- | --- |
| **92.0%** | 74.3% | 90.7% | 2.62 s | 441 | 免费（30 次/分上限） |

> 【实测 2026-10-24，真 Key】`GET https://api.search.tinyfish.ai?query=…` → **HTTP 200 / 2.20 s / 10 条**，
> 每条带 `date` 字段（如 `6 days ago`、`5 months ago`），插件映射成 `publishedAt`，会话里显示为
> 标题后的 `(Oct 7, 2026)`。假 Key 的失败也测了：**0.53 s** 返回 `401 INVALID_API_KEY`——
> 这决定了「限速即时切换」的代价只有一次失败往返，而不是卡住整次调用。
>
> **中文质量【实测 3/3，2026-10-24】**（此前标【未核实】，现已补测）：
>
> | 中文查询 | 官方/权威源是否进 top-3 | 是否带日期 |
> | --- | --- | --- |
> | 小米 Watch 5 最新固件更新 | ✅ 第 1 条 mi.com 官方 FAQ，第 3 条 mi.com 产品页 | ✅ `(Sep 13, 2026)` 固件 OS3.0.196.0 |
> | AnySearch 免费额度 1000 次/天 | ✅ 第 5 条官方 pricing 页 | ✅ 多条 `(Oct 15/16, 2026)` |
> | DeepSeek V4 发布时间 | ✅ 第 1/2/3 条全是 `api-docs.deepseek.com` 官方发布稿 | ✅ `(Sep 10, 2026)` 等 |
>
> 结论：中文查询它并不弱，官方源命中与日期都对得上；3 题样本小，但足够推翻「TinyFish 只擅长英文」的先验。

TinyFish 官方文档（<https://docs.tinyfish.ai/search-api>，2026-10-24 抓取）另给了两个关键事实，比插件
README 里的「500 次/时」更新：**搜索免费额度是 12,000 次/天**（超出才需钱包余额，重置 00:00 UTC）；
并且**支持日期过滤**——`after_date` / `before_date`（`YYYY-MM-DD`）、`recency_minutes`（1–5256000）、
`domain_type=news|research_paper`。这正是 AnySearch 缺的能力，所以「时间敏感的问题」优先走 TinyFish。

同一榜单第一名是 Exa `type=fast` 99.3%（付费档），TinyFish 92.0% 属于免费档里很强的位置。
**结论：TinyFish 打头站得住**——92.0% 来自英文事实查证榜，中文我另补了 3 题实测（上方表格）3/3 命中官方源
且带日期；它的确定性优势是**日期过滤 + 12,000 次/天额度 + 0.53 s 的失败返回**，正好补 AnySearch 的短板
（无日期、1,000 次/天）。AnySearch 保留在兜底位，中文长尾与 `extract` 抓取仍然靠它。

AnySearch 侧的背书只有厂商口径（[CSDN 报道](https://www.csdn.net/article/2026-10-12/167663993)，2026-10-12）：
Frames / FreshQA / WebWalkerQA 共 300 题整体准确率 76.4%、复杂多跳比传统网页搜索高 18.4 个百分点、
复杂任务端到端约 47.8 s。这个数**没有独立复现**，标【厂商口径】，别当实测用。

### 5.3 抓取（`web_fetch`）实测

AnySearch 的 `/v1/extract` 把网页转成 markdown，单页上限 50000 字符；实测抽取能力比预期强：

| 目标 | 结果 |
| --- | --- |
| `waveshare.net/shop/ESP32-S3-AUDIO-Board.htm` | ✅ 1857 字干净正文，0.5 s |
| `www.mi.com/global/product/xiaomi-watch-5/specs/`（JS 渲染的规格页） | ✅ 2016 字，0.6 s |
| `github.com/deepseek-ai/deepseek-harness` | ✅ 20518 字，0.4 s |
| `zh.wikipedia.org/wiki/ESP32` | ✅ 17509 字，0.3 s |
| `openbenchmarks.com/web-search` | ✅ 49925 字，0.9 s（**正好触到 5 万字符上限**，长文档会被截） |
| `zhuanlan.zhihu.com/p/...`（知乎专栏） | ❌ extract 422 + 裸 GET 被反爬 → 两级都失败，知乎正文读不到 |
| `ithome.com` 文章 | ✅ 但 **15.4 s**（慢站点会顶到上层超时预算） |

- 兜底逻辑（extract 失败 → 裸 GET + HTML 转纯文本）代码里在，但这轮没抓到"extract 挂、裸 GET 成功"的活例：
  硬造的失败（不存在的路径、`no-such-host.invalid`）里裸 GET 也确实是 404，插件会把两级原因一起报出来：
  `AnySearch 抓取两级都失败（…）：extract 阶段：HTTP 422（…）；HTTP 兜底：HTTP 404`。
- extract **不暴露目标站真实状态码**（它自己恒 200），`statusCode` 只在裸 GET 兜底路径上才反映原站状态；
  判断「页面是否真的存在」必须看正文内容，不能看状态码。


## 6. 检索纪律（本次事故的整改）

1. 任何「有没有 / 支不支持 / 多少钱 / 最新版本」类结论，必须**至少两个独立来源**，或一个**官方原始页面**。
2. 必须抓原文（`web_fetch` / curl / `envoy_read`），不接受搜索摘要当证据；结论旁标注抓取日期。
3. 单个 URL 404/000 **不能**推出「不存在」——换 slug、换路径、换引擎再试，至少两轮。
4. AnySearch 没有日期字段：**时间敏感问题必须到原文找日期**，或改用有日期能力的引擎（TinyFish / 千帆）。
5. 估算值与实测值分开写：`【实测】` / `【估算】` / `【未核实】`。
6. 无法验证就明说无法验证，不给看起来完整的假答案。

## 7. 与官方通道的关系

官方另有一条更省的路：插件设置里打开「Use the new Web Search API」，即走 `deepseek-search-api`
（`https://api.deepseek.com/v1/tools/search`，直接 REST，不再是一次模型 turn）。但它仍消耗 DeepSeek 余额，
而且本机这条 `DEEPSEEK_API_KEY` 是 401，所以现在不用它。
