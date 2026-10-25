# 参与开发

感谢你愿意花时间。这个项目由「一个 DSH 插件 + 一个 Android 客户端 + 一堆文档」组成，
所有代码都在这个仓库里，没有隐藏服务。

## 环境

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 | 插件、脚本、MCP 桥 |
| JDK | 17 | 只用来编 Android；别用 JDK 21+，Gradle 8.13 会报 unsupported class file |
| Android SDK | build-tools 35 + platform 35 | 编译 APK，`minSdk 26` |

## 提交前自查

```bash
bash scripts/verify.sh          # 语法 + 插件/MCP/小爱三套自测 + 线上探针
SKIP_LIVE=1 bash scripts/verify.sh   # 没有宿主时只跑离线部分
```

改了 Android 端还要：

```bash
node --test android/**/*.test.mjs      # 单元测试
bash scripts/android-smoke.sh          # 装机后 17 项冒烟（需要 adb 与一台设备）
```

改了界面文案，跑一次文案检查，error 必须清零：

```bash
node ~/.dsh/skills/ui-restraint/scripts/ui-copy-lint.mjs plugins/dsh-pet-voice
```

## 约定

- **绝不提交密钥**：`local/`、`android/keystore.properties`、`*.jks`、`demo/certs/key.pem` 已在 `.gitignore` 里，别硬塞进来。
- **不新增个人路径**：测试与文档里出现的目录一律用 `/tmp/…` 或 `~/…`，不要写自己机器的绝对路径。
- **改接口就改契约**：`docs/pet-contract.md` 是手机端与插件的唯一约定，端点字段变了同步更新它，否则 CI 会炸。
- **动画资源别手改**：`plugins/dsh-pet-voice/public/pet/index.html` 是生成物，改 `scripts/gen-pet-asset.mjs` 后重新生成。
- **提交信息**：一句话说清「改了什么、为什么」，中文英文都行。

## Pull Request

1. 从 `main` 切分支，一个 PR 只做一件事；
2. 描述里写清复现/验证方法，能贴实测输出最好；
3. 涉及用户可见行为变更的，附上改动前后截图或录屏；
4. 自测通过再请求评审，评审意见会直接标在代码行上。

## 报告问题

功能缺陷用 Issue 模板；涉及安全（鉴权绕过、凭证泄漏、签名问题）请走 [SECURITY.md](SECURITY.md)，不要开公开 Issue。
