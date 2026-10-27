# 宠物语音链路稳定性压测（无麦克风）

由 [`scripts/pet-stress.mjs`](../scripts/pet-stress.mjs) 生成：一条命令复现，不需要真人说话。

- 生成时间：2026-10-27 01:16:43
- 宿主机：脚本用 `scripts/lib/pv-base.sh` 现探（DSH 端口每次启动都可能变，别写死）
- 压测落点：`session-9918aec4-df16-4fb7-93cb-5608db272a04`；并发 n=8；段：all
- 结果：**全部通过**（29 项检查）

## 检查项

| 检查 | 结果 | 说明 |
|---|---|---|
| serial：每轮 200/202 且 start→final→end 齐全 | ✓ | 8/8 轮完整 |
| serial：跑完记号清零 | ✓ | 25 ms 内清空 |
| concurrent：8 条同时点全部被受理（无 500/超时） | ✓ | status=200,200,200,200,200,200,200,200 |
| concurrent：挤掉旧轮之后最后一轮仍能跑完 | ✓ | 收到 start→end |
| concurrent：并发后不残留 live 记号 | ✓ | 6099 ms 内清空 |
| mixed：真会话并发仍被受理 | ✓ | status=200,200,200,200 |
| mixed：不存在会话返回 404 且不是 500 | ✓ | status=404,404,404,404 |
| mixed：错误路径不把记号挂死 | ✓ | 1091 ms 内清空 |
| cancel#0：派发后被受理且 cancel 回 200 | ✓ | dispatch=200 cancel=200 |
| cancel#1：派发后被受理且 cancel 回 200 | ✓ | dispatch=200 cancel=200 |
| cancel#2：派发后被受理且 cancel 回 200 | ✓ | dispatch=200 cancel=200 |
| cancel#3：派发后被受理且 cancel 回 200 | ✓ | dispatch=200 cancel=200 |
| cancel：取消后仍能完整聊下一轮 | ✓ | 收到 end |
| cancel：取消后记号清零 | ✓ | 3 ms 内清空 |
| interrupt：新轮挤掉旧轮，每次都还能跑完 | ✓ | [{"first":200,"second":200,"end":true},{"first":200,"second":200,"end":true},{"first":200,"second":200,"end":true},{"first":200,"second":200,"end":true}] |
| interrupt：交替打断后不残留 | ✓ | 5 ms 内清空 |
| poll：40 个并发高频请求全部 200 | ✓ | p95=99ms max=99ms（分类 max：`poll-backlog` 97ms、`state` 99ms、`sessions` 99ms、`poll-wait` 99ms） |
| poll：状态/轮询并发下响应不超过 3s | ✓ | max=99ms |
| reconnect：连上后能收到 start | ✓ | 收到 start |
| reconnect：断线重连后靠 /poll 能追到 end | ✓ | 收到 end |
| reconnect：断线不留死连接/记号 | ✓ | 1 ms 内清空 |
| 收尾：全部压测结束后目标会话无残留记号 | ✓ | 1 ms 内清空 |
| 收尾：SSE 流表回到压测前的量 | ✓ | 前 0 → 后 0 |
| 收尾：其它会话的 live 记号（桌面端同时在用，仅记录） | ✓ | 前 0 → 后 0 |
| HTTP：全程没有 5xx | ✓ | 5645 个请求 |
| HTTP：全程没有超时/连不上 | ✓ | 0 个 |
| 日志：压测期间没有 end-hold 阶梯 | ✓ | turn.log 新增 38 行，本会话 0 个 end-hold |
| 日志：压测期间没有服务端异常行 | ✓ | 无 |
| 日志：有派发流水（证明压测真的打到了宿主） | ✓ | 新增 38 行 / 54s |

## 各段耗时

| 段 | 耗时 (ms) |
|---|---|
| serial | 16391 |
| concurrent | 11465 |
| mixed | 5231 |
| cancel | 5081 |
| interrupt | 11976 |
| poll | 101 |
| reconnect | 4000 |

## 旁证

- turn.log 新增 38 行，本会话 end-hold 0 行，异常 0 行
- HTTP：5645 个请求，非 200/202/206 的 8 个，5xx 0 个

## 没折腾的

- 不碰用户桌面会话：跨会话那一段只往「不存在的会话」上打，验证错误路径并发，不验证别的会话跑不跑得动（那要真人桌面会话配合，压测里不制造）。
- 断网/隧道丢包：本机回环复现不了，断线只模拟为「客户端主动掐 SSE + 轮询兜底」。
