# 上游基线

| 本地包 | 来源 | 基线 |
| --- | --- | --- |
| `pi-subagents` | https://github.com/gotgenes/pi-packages ，目录 `packages/pi-subagents` | tag `pi-subagents-v21.5.0`；commit `e311a0d1eff8ce73db43912b7483cbf15faf0fa3` |
| `pi-permission-system` | 同上，目录 `packages/pi-permission-system` | tag `pi-permission-system-v31.1.3`；commit `cf99c19b2cad9d26f6c4d0b9dc464c7fde0fab18` |
| `pi-openai-toolkit` | https://github.com/awoaCrim/pi-openai-toolkit | commit `32d568ab6b58f8c914e3c143d625869a71ad55a3` |
| `pi-auto-mode` | 本地 `~/Projects/pi-model-approver/`，导入时改目录名 | 初始快照提交 `e9b80ae6`；Toolkit 策略快照归属见包内 `src/vendor/toolkit/README.md` |

## 历史保留

这不是浅克隆或只留下版本号：三个上游基线及其历史已通过 `ours` 合并成为本仓主线的祖先。合并仅保留历史，不把无关上游包加入当前工作树。全新克隆本仓主线也能保留这些祖先。

本地查询上游历史：

```bash
git log e311a0d1 -- packages/pi-subagents
git log cf99c19b -- packages/pi-permission-system
git log 32d568ab -- src/auto-mode
```

当前差异对比：

```bash
git diff e311a0d1:packages/pi-subagents HEAD:packages/pi-subagents
git diff cf99c19b:packages/pi-permission-system HEAD:packages/pi-permission-system
git diff 32d568ab HEAD:packages/pi-openai-toolkit
```

## 集成差异

- 建立 pnpm workspace、统一锁文件与根目录检查命令；保留各上游包的测试和开发版本基线。
- 所有包标为私有，未发布或修改上游归属。
- `pi-auto-mode` 通过 `workspace:*` 链接本仓两个 gotgenes 服务包，而非另装注册表副本；其运行逻辑未重写。
- Toolkit 加载清单不再包含 `extensions/auto-mode.ts`；相应清单测试同步调整。原 Auto 源码保留，但不作为第二个门禁自动加载。
- Toolkit 移除 npm `bun` 开发依赖，改为环境前置要求，避免跳过安装脚本后空执行文件造成测试假通过。
- pnpm catalog 和 TypeScript 基础配置取自 gotgenes 基线并缩减到当前使用项。

后续更新先 fetch 并审查对应包的变更，再导入选定目录、解决上述集成差异并运行检查。不要将整个上游主线直接 merge 到工作树，也不要在未决定授权边界前放宽审批规则。
