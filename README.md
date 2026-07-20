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

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `EOLINK_BASE_URL` | 是 | Eolink 实例 Open API 地址，如 `https://your-eolink.example.com` |
| `EOLINK_TOKEN` | 是 | Open API 令牌（对应请求头 `Eo-Secret-Key`） |
| `EOLINK_SPACE_ID` | 是 | 工作空间 ID |
| `EOLINK_NO_PROXY` | 否 | 设 `1` 禁用代理解析（默认自动读 `HTTP(S)_PROXY`） |

### Claude Code

**方式一：全局 bin（推荐，多实例安全）**

```bash
npm install -g @huberyhe/eolink-mcp@1.1.0
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

在 Eolink 后台「空间设置 / 开放 API」处生成 Open API 令牌（即 `Eo-Secret-Key`）；`space_id` 为工作空间标识；`EOLINK_BASE_URL` 为实例 Open API 根地址。

## 代理

访问 Eolink 实例（尤其私有化内网部署）常需经代理。本 server 自动读取 `HTTP(S)_PROXY` 环境变量；设 `EOLINK_NO_PROXY=1` 可禁用。

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

测试用 MCP Inspector：

```bash
npx @modelcontextprotocol/inspector --cli --transport stdio \
  -e EOLINK_BASE_URL=xxx -e EOLINK_TOKEN=xxx -e EOLINK_SPACE_ID=xxx \
  --method tools/list -- node dist/index.js
```

## License

MIT
