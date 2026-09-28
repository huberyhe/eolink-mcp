# eolink-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants (Claude Code, etc.) query API documentation from any **Eolink Apikit** instance — SaaS or private deployment — via the Eolink Open API.

## 安装

```bash
npm install -g @huberyhe/eolink-mcp     # 推荐：全局安装，多实例无竞态
# 或
npx @huberyhe/eolink-mcp                # 免安装直接运行（首次需下载）
```

> 多个 Claude Code 实例同时冷启动时，npx 共用缓存可能偶现竞态导致 `not found`。全局安装可完全避免。

## 提供的工具

**查询（只读）**

| 工具 | 用途 | project_id |
| --- | --- | --- |
| `eolink_health_check` | 配置自检：配置项/连通性/鉴权逐项体检，并标明各项来源（排障第一步） | 不需要 |
| `eolink_list_projects` | 列出空间所有项目（第一步） | 不需要 |
| `eolink_list_groups` | 列出指定项目的接口分组树 | 必填 |
| `eolink_search_apis` | 按关键字/分组/状态模糊搜索接口（匹配名称/URL/Tag） | 必填 |
| `eolink_find_api_by_path` | 按 api_path 精确/前缀查找接口 | 必填 |
| `eolink_get_api_detail` | 按 api_id 获取单个接口的完整定义（请求/响应参数） | 必填 |
| `eolink_export_openapi` | 导出整个项目为 OpenAPI JSON（兜底全量） | 必填 |

**写入（会改动 Eolink 文档）**

| 工具 | 用途 | project_id |
| --- | --- | --- |
| `eolink_create_api` | 新增 HTTP 接口（不传 api_id） | 必填 |
| `eolink_update_api` | 修改已有接口（传 api_id） | 必填 |
| `eolink_create_group` | 新增接口分组 | 必填 |

> ⚠️ 写工具默认启用，AI 可直接增改接口文档。修改建议先 `get_api_detail` 确认当前内容。Eolink Open API 不开放删除接口，删除请到 Eolink 后台手动操作。写操作经 `/index.php/` 入口，`add_group` 使用 form-urlencoded 格式——这些差异已内置处理，使用者无需关心。参数类型 `param_type` 用数字（0=string 3=int 2=json 8=boolean 等）。

典型流程：`list_projects` → `search_apis` 或 `find_api_by_path`（带 project_id）→ `get_api_detail`。

> 按名称找用 `search_apis`；按 URL 找用 `find_api_by_path`（`exact` 等值 / `prefix` 前缀），比模糊搜索更精准。

## 配置

配置项支持**命令行参数**与**环境变量**两种来源，**命令行参数优先**。两者可混用——
只传部分参数时，其余项自动回落到环境变量。

| 命令行参数 | 环境变量 | 必填 | 说明 |
| --- | --- | --- | --- |
| `--base-url <url>` | `EOLINK_BASE_URL` | 是 | Eolink 实例 Open API 地址，如 `https://your-eolink.example.com` |
| `--token <token>` | `EOLINK_TOKEN` | 是 | Open API 令牌（对应请求头 `Eo-Secret-Key`） |
| `--space-id <id>` | `EOLINK_SPACE_ID` | 是 | 工作空间 ID |
| `--no-proxy` | `EOLINK_NO_PROXY=1` | 否 | 禁用代理解析（默认自动读 `HTTP(S)_PROXY`） |
| `--verify-on-start` | `EOLINK_VERIFY_ON_START=1` | 否 | 启动时联网校验凭据有效性（见下） |
| `-h`, `--help` | — | 否 | 打印用法 |

`--key=value` 与 `--key value` 两种写法都支持；**值本身以 `-` 开头时必须用 `=` 形式**
（如 `--token=-abc123`），否则会被当成另一个参数。开关类参数（`--no-proxy`、`--verify-on-start`）
不接受值，关闭请直接去掉该参数。`--help` 与配置错误信息走 stderr（stdio 下 stdout 被 MCP 协议占用）。

```bash
# 全走命令行参数
eolink-mcp --base-url https://your-eolink.example.com --token <token> --space-id <id>

# 也可混用：token 走参数，其余走环境变量
eolink-mcp --token <token>
```

在 MCP 客户端里通过 `args` 传参：

```json
{
  "mcpServers": {
    "eolink": {
      "command": "eolink-mcp",
      "args": ["--base-url", "https://your-eolink.example.com",
               "--token", "your-token", "--space-id", "your-space-id"]
    }
  }
}
```

> **安全提示**：参数写在 `args` 里会明文出现在客户端配置文件中；更重要的是，
> 命令行参数在进程存活期间可通过 `ps` 或 `/proc/<pid>/cmdline` 被**同机其他用户**读到，
> 而环境变量 `/proc/<pid>/environ` 仅属主可读。因此**多用户 / 共享主机上建议用 `env`
> 而非 `args` 传令牌**；`args` 更适合单用户桌面或调试场景。
> 无论哪种方式，都注意不要提交到版本库。

### 启动时的配置校验

分两层，边界是「能否在本地判定」：

**本地校验（始终生效）**：三个配置项缺失、或 base url 不是合法 `http(s)://` 地址时，
启动即打印明确错误并 `exit(1)`（base url 与 token 的错误会标明生效来源）；token 短于 16 字符时打告警但不退出。

参数层面的问题一律**告警但不退出**（避免客户端往 `args` 塞入自身参数时误伤），包括：
无法识别的参数、空值参数（如 `--token ""`，会回落到环境变量）、
以及给开关类参数传值（如 `--no-proxy=false`——开关不接受值，关闭请直接去掉该参数）。

**联网校验（默认关闭）**：token 格式合法但实际无效（如填错、已过期）时，
本地无从判断，默认要等到调用工具才报错。加 `--verify-on-start`（或设
`EOLINK_VERIFY_ON_START=1`）可改为启动时用一次 `project/search` 探测
（5 秒超时、不重试），凭据无效则立即 `exit(1)`。

> 默认关闭是因为启动时联网探测会拖慢启动，且内网不通/代理未就绪/Eolink 抖动时会把
> 「临时不可达」误判成「配置错误」而拒绝启动。需要「配置错了就当场失败」时再开启。

无论是否开启，任何时候都可用 `eolink_health_check` 按需体检。

### Claude Code

**方式一：全局 bin（推荐，多实例安全）**

```bash
npm install -g @huberyhe/eolink-mcp@1.2.0
```

然后在 `~/.claude.json` 的 `mcpServers` 中添加：

```json
{
  "mcpServers": {
    "eolink": {
      "command": "eolink-mcp",
      "args": [],
      "env": {
        "EOLINK_BASE_URL": "https://your-eolink.example.com",
        "EOLINK_TOKEN": "your-open-api-secret-key",
        "EOLINK_SPACE_ID": "your-space-id"
      }
    }
  }
}
```

**方式二：npx（免安装）**

```json
{
  "mcpServers": {
    "eolink": {
      "command": "npx",
      "args": ["-y", "@huberyhe/eolink-mcp"],
      "env": { ... }
    }
  }
}
```

> npx 首次需下载，多实例冷启动偶现缓存竞态。长期使用推荐全局安装。

**本地调试**：可在配置中保留两条入口，正式用全局 bin，改代码后用 dist 直连：

```json
"eolink":      { "command": "eolink-mcp" },           // 日常
"eolink_test": { "command": "node", "args": ["dist/index.js"] }  // 调试
```

用 `claude mcp list` 查看连接状态。

### 其它 MCP 客户端

任何支持 stdio MCP server 的客户端都适用：command 为 `eolink-mcp`（全局安装）或 `npx -y @huberyhe/eolink-mcp`（免安装），env 同上。

## 获取凭证

在 Eolink 后台「空间设置 / 开放 API」处生成 Open API 令牌（即 `Eo-Secret-Key`）；`space_id` 为工作空间标识；
base url 为实例 Open API 根地址。三者都可用 `--base-url` / `--token` / `--space-id` 参数
或对应的 `EOLINK_*` 环境变量传入。

## 代理

访问 Eolink 实例（尤其私有化内网部署）常需经代理。本 server 自动读取 `HTTP(S)_PROXY` 环境变量；
用 `--no-proxy` 或设 `EOLINK_NO_PROXY=1` 可禁用。

## 排障

**遇到任何 `eolink_*` 工具报错，先调用 `eolink_health_check`** —— 它会逐项报告配置项、**各自的来源（命令行参数 / 环境变量）**、连通性与鉴权状态，并明确指出该改哪一项。令牌只显示遮蔽后的形态（如 `8SnX…75d7`），不会回显明文。

常见故障与对策：

| 现象 | 原因 | 对策 |
| --- | --- | --- |
| `Eolink 鉴权失败`（code 200007） | token 无效或未传；或复制时带了空格/换行 | 到后台「空间设置 / 开放 API」重新生成；本 server 已自动 trim 首尾空白。注意参数会覆盖环境变量，若两处都配了以参数为准 |
| `Eolink 项目校验失败`（code 200301） | `project_id` 无效或不属于该空间 | 先用 `eolink_list_projects` 取正确 ID |
| 启动即失败、`claude mcp list` 显示连接断开 | 缺少必需配置项，或 base url 不是合法地址 | fail-fast 设计；用 `claude mcp list` 或 `--debug` 查看 stderr 里的具体缺项 |
| `Eolink 域名无法解析` / `实例不可达` | base url 写错、内网不通或代理未生效 | 核对 base url（`--base-url` / `EOLINK_BASE_URL`），确认 `HTTP(S)_PROXY` 正确 |
| `响应不是预期的 JSON` | base url 指到了网页根地址而非 Open API 根地址 | 填实例根地址即可（如 `https://your-eolink.example.com`），不要带 `/v2` 或末尾斜杠 |
| `响应过大，超过 64MB 上限被中止` | 导出/搜索的响应体超过保护上限（实测单项目全量导出可达 12MB） | 缩小范围：`export_openapi` 传 `group_ids` 只导部分分组，或改用 `search_apis` + `get_api_detail` 按需取 |

配置层面已内置的容错：base url 自动去尾随斜杠，token / space id 自动 trim 首尾空白；
空的命令行参数值（如 `--token ""`）不会覆盖已有的环境变量。

## 本地开发

```bash
git clone https://github.com/huberyhe/eolink-mcp.git && cd eolink-mcp
npm install && npm run build    # 产物在 dist/index.js
```

改代码后 `npm run build`，重启 MCP 即生效。可在 `~/.claude.json` 中保留两条入口：

```json
"eolink":      { "command": "eolink-mcp" },              // 正式，走 npm
"eolink_test": { "command": "node", "args": ["dist/index.js"] }  // 调试，改代码即生效
```

测试用 MCP Inspector（配置可用 `-e` 传环境变量，或直接在 `--` 后追加命令行参数）：

```bash
npx @modelcontextprotocol/inspector --cli --transport stdio \
  -e EOLINK_BASE_URL=xxx -e EOLINK_TOKEN=xxx -e EOLINK_SPACE_ID=xxx \
  --method tools/list -- node dist/index.js

# 或走命令行参数
npx @modelcontextprotocol/inspector --cli --transport stdio \
  --method tools/list -- node dist/index.js \
  --base-url xxx --token xxx --space-id xxx
```

查看可用参数：

```bash
node dist/index.js --help
```

## License

MIT
