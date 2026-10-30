# dsh-cursor

<p align="center">
  在 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 里使用 Cursor 的模型。
</p>

[English](./README.md) | 简体中文

`dsh-cursor` 注册一个名为 `cursor` 的 DeepSeek Harness LLM 提供方路由（provider route）。
它提供的模型就是你的 Cursor 账号可以选择的模型，模型输出由 Cursor Agent SDK 产生。
安装后，Cursor 的模型会和其他提供方一起出现在 Harness 的模型选择器里。

> 非官方集成。本项目与 Cursor / Anysphere 无关，也未获得其背书。请仅在你有权使用的账号上、并遵守 Cursor 服务条款的前提下使用。

## 工作原理

Cursor 没有公开 chat-completions 接口，它公开的是一个 **agent**：拥有 prompt、工具集和模型选择的本地运行时。
而 Harness 需要的是「每次请求流式返回一条 assistant 消息，并带上完整对话」。

本插件把这两种形态桥接起来：

```
DSH agent loop                 dsh-cursor                        Cursor
────────────────               ──────────                        ──────
llm.stream(request)  ──►  把对话渲染成一个 prompt       ──►  Agent.create(tools:['mcp'])
                          Agent.send(prompt)                ──►  模型 + 自定义工具
  ◄── text-delta  ◄────     onDelta → DSH chunks               text / thinking 增量
  ◄── tool-call   ◄────     在工具边界处 run.cancel()            模型请求调用某个自定义工具
由 Harness 原生执行该工具
```

* 每次请求都会把 Harness 的对话（系统提示、各轮消息、工具调用及其结果）渲染成 **一个 prompt**，交给一个短命的 Cursor agent。
  请求始终是会话日志的纯函数，符合 Harness 的模型调用约定。
* **Cursor 永远不会碰到你的机器。** agent 以 `tools: ['mcp']` 创建，Cursor 自带的文件、Shell、搜索、子 agent 工具都不会注册。
  模型能看到的唯一工具是本次请求的 Harness 工具，以进程内 custom tool 的形式桥接。
* 当模型请求调用这些工具时，插件会 **取消这次 Cursor run**，把工具调用交回给 Harness；
  由 Harness 用自己的权限、沙箱和界面去执行。结果在下一次请求里带回。
* 文本与思考内容通过 `onDelta` 逐 token 流式返回，每轮都会上报 token 用量。

## 安装

从 GitHub 安装：

```sh
dsh plugin --profile web add github:atticuswx/dsh-cursor
```

或者用本地克隆 / 压缩包：

```sh
git clone https://github.com/atticuswx/dsh-cursor
dsh plugin --profile web add ./dsh-cursor
# 或：dsh plugin --profile web add ./dist/dsh-cursor-0.2.0.tgz
```

包内声明了 DSH bundle patch，安装后会自动挂载 provider。
刷新页面（或重启 `dsh web`），打开 **设置 > 模型**，**Cursor** 一行里会出现它的 API Key 卡片。

这个包**没有发布到 npm**，请从 GitHub 或本地目录安装。因此 `npx dsh-cursor login` 只在
本仓库内（`node bin/cursor-login.mjs login`）或全局 git 安装后可用；直接在卡片里粘贴 Key 则不需要任何 CLI。

## API Key 与多账号

打开 **设置 > 模型 > Cursor**。Cursor 卡片可以管理任意多个 API Key，并选择每次请求使用哪一个：

- **添加 Key**：粘贴 Key、填一个备注名；第一个 Key 会自动生效。
- 单选框选择**生效中**的 Key。请求会用该 Key 对应的账号认证，模型目录也跟着切换，所以换账号只需点一下
  （切换后重新打开模型选择器即可看到新账号的模型）。
- **更换 Key** 重写已保存的密钥；**删除** 会移除条目并清除已保存的凭证。只改备注名不会碰密钥。
- Key 保存在 Harness 凭证服务里，引用名是自动生成的 `CURSOR_KEY_*`，保存后不会再返回页面；
  列表只显示引用名和末四位。
- Key 列表和选中项写在本插件的设置里，重启后仍然有效；密钥本身在 `$DSH_HOME/.credentials.yaml`。

没有托管 Key 时，仍按原来的顺序回退：

1. **设置 > 模型** 输入框保存的 Key（凭证 `CURSOR_API_KEY`）；
2. 环境变量 `CURSOR_API_KEY`；
3. 之前用 `npx dsh-cursor login` 存在 `~/.cursor/sdk/auth.json` 的登录凭证。

Key 在 <https://cursor.com/dashboard/api> 创建。Cursor SDK 不支持 Team Admin API key，请使用 user key 或 service account key。

### 浏览器登录（单 Key，不改设置）

```sh
npx dsh-cursor login     # 打开浏览器，把 user API key 存到 ~/.cursor
npx dsh-cursor status    # 是否已登录
npx dsh-cursor models    # 该账号可选的模型 id
npx dsh-cursor logout    # 清除已保存的登录
```

这个登录只是最后一道回退；一旦存在托管 Key，就以托管 Key 为准。

## 模型

模型目录来自 `Cursor.models.list()`，按**当前生效账号**（选中的托管 Key；未托管时按回退凭证）获取，按凭证缓存十分钟。
模型自带的参数会在「思考」类参数（`thinking`、`reasoning`、`effort` 等）上映射为 Harness 的推理强度选择器。

如果无法自动发现（例如内网环境），可以在插件配置里显式列出模型 id：

```yaml
- id: dsh-cursor
  name: dsh-cursor
  config:
    apiKeyEnv: CURSOR_API_KEY
    models:
      - composer-2
      - gpt-5
```

## 能得到什么，以及放弃了什么

可用：

* 模型选择、流式文本、流式思考、token 用量
* 完整的 Harness 工具集（bash、文件编辑、grep、todo、子 agent、MCP 工具……），
  并且继续走 Harness 的权限、沙箱与审批
* 会话标题、上下文压缩等所有辅助模型调用

有意的限制：

* **每次请求都会重放对话。** Cursor 的 agent 是有状态的，而 Harness 的请求不是，
  所以每一轮都以「完整对话快照」的形式发送。提示缓存让实际成本可控，
  但上报的输入 token 数会高于原生 provider。
* **工具调用会终止这次 Cursor run。** 动手的是 Harness 而不是 Cursor，
  因此 Cursor 在两次工具调用之间的规划是一步一步进行的。
* **不支持图片输入。** 附件会替换为文本占位符，因为桥接的 prompt 通道是纯文本的。
* **辅助调用同样是一次 agent run。** 会话标题与压缩各消耗一次 Cursor run。
* Cursor 会按 SDK 的正常行为在 `~/.cursor` 下写本地 agent store，插件未做改动。

## 排错

| 现象 | 处理 |
| --- | --- |
| 选择器里没有 Cursor 模型 | 没有生效的 Key。在 **设置 > 模型 > Cursor** 卡片里添加一个，或在该行的 Key 输入框里粘贴一个，也可 `npx dsh-cursor status` / `npx dsh-cursor login`。 |
| 会话里出现 `AUTH` 失败 | 生效的 Key 或回退凭证过期、被撤销。在 **设置 > 模型 > Cursor** 里更换，或重新登录。 |
| `CURSOR_UNAVAILABLE` | `@cursor/sdk` 加载失败。重新安装该包；宿主需 Node.js 22.13 及以上。 |
| `INVALID_REQUEST` 且提到模型 | 该模型未对当前账号开放，`npx dsh-cursor models` 查看。 |
| `QUOTA` | Cursor 套餐在该模型上没有剩余额度。 |

## 开发

```sh
npm install
npm test        # node --test，无需网络与凭证
npm run check   # 入口文件语法检查
npm run pack:dist
```

全新克隆会运行凭证、模型目录、transcript、bridge 和设置卡片相关的测试，
跳过 6 个需要导入 Harness peer 包的检查。想跑全量测试，需要让本仓库能解析到
DSH 的 peer 包；在装有 `web` profile 的机器上，链接到宿主自身加载的那一份，
避免出现重复模块实例：

```sh
ln -s "$DSH_HOME/profiles/node_modules/@deepseek-ai" node_modules/@deepseek-ai
```

`node scripts/smoke.mjs --stream` 会用真实 SDK 跑一遍适配器（需要凭证）。

由于包是装进 profile 的，新增 bundle 后需要一次完整的 profile 组装才会生效：
重启 `dsh web`，或使用宿主内的插件管理器（可热应用）。

目录：

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 插件入口：provider 路由、配置、凭证、模型目录 |
| `lib/client.js` | 设置 > 模型 > Cursor 卡片：多 Key 管理与生效选择 |
| `lib/keys.js` | Key 注册表归一化与凭证解析决策 |
| `lib/bridge.js` | Cursor run → Harness 流式 chunk，工具调用交接与取消 |
| `lib/transcript.js` | 确定性请求 → prompt 渲染 |
| `lib/catalog.js` | `Cursor.models.list()` 缓存、推理参数映射 |
| `lib/errors.js` | SDK 失败 → Harness 失败码转换 |
| `bin/cursor-login.mjs` | `login` / `status` / `models` / `logout` 命令 |

## 兼容性

目标 **DeepSeek Harness `0.2.1-rc.2`**（`engines.dsh`）、Node.js **22.13+**（`@cursor/sdk` 要求）、
`@cursor/sdk` **1.2.x**。

## 许可证

MIT
