# 小米侧接入口径（核查 2026-10-24）

**结论**：小米无官方第三方 MCP；小爱唯一接入点是**手机自定义技能**（你给 HTTPS 服务端，小爱把意图 POST 过来）。

- 技能协议三态：`request.type` 0=进入（可 `open_mic`）、1=进行中（路由意图）、2=结束；回复固定 `{"version":"1.0","response":{"to_speak":{"type":0,"text":…},"open_mic":false}}`。
- 硬性规则：公网 HTTPS、显式唤醒、`is_session_end` 决定是否延续、签名 `MIAI-HmacSHA256-V1`。

社区「米家 MCP」（mcp-mijia、miot-mcp）都是米家/MIoT 云端接口的壳，非官方，也不是小爱入口。

- 小爱开放平台：https://developers.xiaoai.mi.com/
- 官方开源（非 MCP）：https://github.com/XiaoMi/ha_xiaomi_home
