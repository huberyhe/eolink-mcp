# eolink-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants (Claude Code, etc.) query API documentation from any **Eolink Apikit** instance — SaaS or private deployment — via the Eolink Open API.

## 安装

```bash
npx @huberyhe/eolink-mcp
```

## 提供的工具

| 工具 | 用途 | project_id |
| --- | --- | --- |
| `eolink_list_projects` | 列出空间所有项目（第一步） | 不需要 |
| `eolink_list_groups` | 列出指定项目的接口分组树 | 必填 |
| `eolink_search_apis` | 按关键字/分组/状态模糊搜索接口（匹配名称/URL/Tag） | 必填 |
| `eolink_find_api_by_path` | 按 api_path 精确/前缀查找接口 | 必填 |
| `eolink_get_api_detail` | 按 api_id 获取单个接口的完整定义（请求/响应参数） | 必填 |
| `eolink_export_openapi` | 导出整个项目为 OpenAPI JSON（兜底全量） | 必填 |

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

在 `~/.claude.json` 的 `mcpServers` 中添加：

```json
{
  "mcpServers": {
    "eolink": {
      "command": "npx",
      "args": ["-y", "@huberyhe/eolink-mcp"],
      "env": {
        "EOLINK_BASE_URL": "https://your-eolink.example.com",
        "EOLINK_TOKEN": "your-open-api-secret-key",
        "EOLINK_SPACE_ID": "your-space-id"
      }
    }
  }
}
```

或用 CLI：`claude mcp add eolink -s user -e EOLINK_BASE_URL=... -e EOLINK_TOKEN=... -e EOLINK_SPACE_ID=... -- npx -y @huberyhe/eolink-mcp`，用 `claude mcp list` 查看连接状态。

### 其它 MCP 客户端

任何支持 stdio MCP server 的客户端都适用：command 为 `npx`，args 为 `["-y", "@huberyhe/eolink-mcp"]`，env 同上。

## 获取凭证

在 Eolink 后台「空间设置 / 开放 API」处生成 Open API 令牌（即 `Eo-Secret-Key`）；`space_id` 为工作空间标识；`EOLINK_BASE_URL` 为实例 Open API 根地址。

## 代理

访问 Eolink 实例（尤其私有化内网部署）常需经代理。本 server 自动读取 `HTTP(S)_PROXY` 环境变量；设 `EOLINK_NO_PROXY=1` 可禁用。

## 本地开发

```bash
git clone https://github.com/huberyhe/eolink-mcp.git && cd eolink-mcp
npm install && npm run build
```

测试用 MCP Inspector：

```bash
npx @modelcontextprotocol/inspector --cli --transport stdio \
  -e EOLINK_BASE_URL=xxx -e EOLINK_TOKEN=xxx -e EOLINK_SPACE_ID=xxx \
  --method tools/list -- node dist/index.js
```

## License

MIT
