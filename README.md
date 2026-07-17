# eolink-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants (Claude Code, etc.) query API documentation from any **Eolink Apikit** instance — SaaS or private deployment — via the Eolink Open API.

无状态设计：`project_id` 不写进配置、不存内存态，每次工具调用由参数显式传入。无任何内建凭证，BASE_URL / 令牌 / 空间 ID 全部由使用者通过环境变量提供 —— 适用于任何 Eolink 部署。

## 安装与使用

无需 clone 源码，直接用 `npx` 运行：

```bash
npx @huberyhe/eolink-mcp
```

> 首次运行 npx 会自动下载；之后每次启动由 MCP 客户端拉起。

## 提供的工具

| 工具 | 用途 | project_id |
| --- | --- | --- |
| `eolink_list_projects` | 列出空间所有项目（第一步） | 不需要 |
| `eolink_list_groups` | 列出指定项目的接口分组树 | 必填 |
| `eolink_search_apis` | 按关键字/分组/状态模糊搜索接口（匹配名称/URL/Tag） | 必填 |
| `eolink_find_api_by_path` | 按 api_path 精确/前缀查找接口（规避模糊搜索噪声） | 必填 |
| `eolink_get_api_detail` | 按 api_id 获取单个接口的完整定义（请求/响应参数） | 必填 |
| `eolink_export_openapi` | 导出整个项目为 OpenAPI JSON（兜底全量） | 必填 |

典型流程：
- 按名称/关键字找：`list_projects` → `search_apis`（带 project_id + keyword）→ `get_api_detail`
- 按 URL 找：`list_projects` → `find_api_by_path`（带 project_id + api_path）→ `get_api_detail`

> `search_apis` 的 keyword 是模糊分词匹配，短路径会命中大量噪声；按 URL 查接口时用 `find_api_by_path` 更精准（`exact` 等值 / `prefix` 前缀）。

## 配置

凭证从环境变量读取，包内不硬编码任何地址或令牌：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `EOLINK_BASE_URL` | 是 | Eolink 实例 Open API 地址，如 `https://your-eolink.example.com` |
| `EOLINK_TOKEN` | 是 | Open API 令牌（对应请求头 `Eo-Secret-Key`） |
| `EOLINK_SPACE_ID` | 是 | 工作空间 ID（space_id） |
| `EOLINK_NO_PROXY` | 否 | 设 `1` 禁用代理解析（默认自动读 `HTTP(S)_PROXY`） |

### Claude Code

在 `~/.claude.json` 的 `mcpServers` 中添加（用户级，所有项目可用）：

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

或用 CLI 注册：

```bash
claude mcp add eolink -s user \
  -e EOLINK_BASE_URL=https://your-eolink.example.com \
  -e EOLINK_TOKEN=your-open-api-secret-key \
  -e EOLINK_SPACE_ID=your-space-id \
  -- npx -y @huberyhe/eolink-mcp
```

用 `claude mcp list` 查看连接状态。

### Cursor / 其它 MCP 客户端

任何支持 stdio MCP server 的客户端都适用。配置项等价：command 为 `npx`，args 为 `["-y", "@huberyhe/eolink-mcp"]`，env 同上。

## 获取凭证

在 Eolink 后台「空间设置 / 开放 API」处生成 Open API 令牌（即 `Eo-Secret-Key`）；`space_id` 为工作空间域名标识；`EOLINK_BASE_URL` 为实例 Open API 根地址。

## 网络 / 代理

访问 Eolink 实例（尤其私有化内网部署）常需经代理。Node 的 axios 默认不读系统 `HTTP(S)_PROXY`，本 server 自动读取 `HTTP(S)_PROXY` 环境变量并透传给 axios；设 `EOLINK_NO_PROXY=1` 可禁用。冷启动首次请求可能因代理握手慢而偶发超时，重试即恢复。

## 调用的 Eolink Open API

| 接口 | 用途 |
| --- | --- |
| `POST /v2/api_studio/management/project/search` | 列项目（无需 project_id） |
| `POST /v2/api_studio/management/api/get_group_list` | 分组树 |
| `POST /v2/api_studio/management/api/search` | 搜接口 |
| `POST /v2/api_studio/management/api/api_info` | 接口详情 |
| `POST /v2/api_studio/management/api/export` | 导出（兜底） |

> 部分网关对成功请求返回 HTTP 302，但 body 是合法 JSON，server 已处理（`maxRedirects:0` + `validateStatus` 接受 302，直接解析 body）。

## 本地开发

```bash
git clone <repo> && cd eolink-mcp-server
npm install
npm run build      # 产物在 dist/index.js
npm run dev        # tsx 热重载
```

测试用官方 MCP Inspector：

```bash
npx @modelcontextprotocol/inspector --cli --transport stdio \
  -e EOLINK_BASE_URL=xxx -e EOLINK_TOKEN=xxx -e EOLINK_SPACE_ID=xxx \
  --method tools/list -- node dist/index.js
```

## 发布

```bash
npm login          # 用 npmjs.com 账号登录
npm publish --access public   # scope 包默认私有，需 --access public
```

`prepublishOnly` 会自动 clean + build + chmod。

## License

MIT
