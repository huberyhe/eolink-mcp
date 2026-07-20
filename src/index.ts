#!/usr/bin/env node
/**
 * Eolink MCP Server
 *
 * 让 AI 通过 Eolink Open API 查询私有化实例里的接口文档。
 * 传输方式：stdio（本地集成，配置在 ~/.claude.json）。
 *
 * 无状态模型：project_id 不保存在内存、不在环境变量里，每次工具调用
 * 由参数显式传入。典型流程：
 *   1. eolink_list_projects        列出空间下所有项目，拿到 project_id
 *   2. eolink_list_groups          传 project_id，看分组
 *   3. eolink_search_apis          传 project_id，搜接口拿 api_id
 *   4. eolink_get_api_detail       传 project_id + api_id，看完整定义
 *
 * 凭证从环境变量读取（见 constants.ts）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertConfig, CHARACTER_LIMIT } from "./constants.js";
import { eolinkRequest, isOk } from "./eolinkClient.js";

assertConfig();

const server = new McpServer({
  name: "eolink-mcp-server",
  version: "1.2.0",
});

/** project_id 参数的 Zod 片段，所有需要项目的工具复用。必填。 */
const projectIdRequired = z
  .string()
  .min(1)
  .describe("项目 ID（先用 eolink_list_projects 获取）");

// ---------------------------------------------------------------------------
// 工具 1：列出所有项目
// ---------------------------------------------------------------------------
server.registerTool(
  "eolink_list_projects",
  {
    title: "列出 Eolink 项目",
    description: `列出当前 Eolink 工作空间下的所有项目（调用 /v2/api_studio/management/project/search）。

不需要参数。返回每个项目的 project_id 和 project_name（以及创建人、是否归档）。

这是使用其它工具前的第一步：拿到目标项目的 project_id，再在 list_groups / search_apis / get_api_detail / export_openapi 调用时显式传入。`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    const resp = await eolinkRequest<{
      status: string;
      result?: Array<Record<string, unknown>>;
    }>("v2/api_studio/management/project/search", undefined, {}, true);
    if (!isOk(resp)) {
      return errText("列出项目失败", resp);
    }
    const items = resp.result ?? [];
    const text = renderProjects(items);
    return {
      content: [{ type: "text", text }],
      structuredContent: { count: items.length, projects: items },
    };
  }
);

// ---------------------------------------------------------------------------
// 工具 2：列出接口分组树
// ---------------------------------------------------------------------------
const ListGroupsSchema = z
  .object({
    project_id: projectIdRequired,
  })
  .strict();

server.registerTool(
  "eolink_list_groups",
  {
    title: "列出 Eolink 接口分组",
    description: `列出指定项目下的所有接口分组（含子分组），用于了解接口按业务模块的组织结构。

参数：
  - project_id：项目 ID（先用 eolink_list_projects 获取）

返回分组树，每个分组含 group_id、group_name、parent_group_id，子分组在 group_child_list 里。

典型用法：本工具拿到 group_id 后，用 eolink_search_apis 的 group_ids 过滤某模块下的接口。`,
    inputSchema: ListGroupsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    const resp = await eolinkRequest<{ status: string; group_list: unknown[] }>(
      "v2/api_studio/management/api/get_group_list",
      params.project_id
    );
    if (!isOk(resp)) {
      return errText("获取分组失败", resp);
    }
    const text = renderGroups(resp.group_list);
    return {
      content: [{ type: "text", text }],
      structuredContent: { count: resp.group_list.length, groups: resp.group_list },
    };
  }
);

// ---------------------------------------------------------------------------
// 工具 3：搜索接口
// ---------------------------------------------------------------------------
const SearchApisSchema = z
  .object({
    project_id: projectIdRequired,
    keyword: z
      .string()
      .max(200)
      .optional()
      .describe("搜索关键字，匹配 API 名称、URL 或 Tag。留空则返回所有接口"),
    group_ids: z
      .array(z.number().int())
      .optional()
      .describe("按分组 ID 过滤，可先用 eolink_list_groups 获取。如 [311986]"),
    api_status: z
      .enum(["enable", "disable"])
      .optional()
      .describe("接口状态过滤：enable=已启用，disable=已禁用"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(30)
      .describe("最多返回的接口数量（默认 30）"),
  })
  .strict();

server.registerTool(
  "eolink_search_apis",
  {
    title: "搜索 Eolink 接口",
    description: `按关键字、分组或状态搜索指定项目里的接口，返回接口列表（api_id、名称、URL、方法、分组等）。

这是查接口最常用的入口。拿到 api_id 后，用 eolink_get_api_detail 获取完整定义。

参数：
  - project_id：项目 ID（必填，先用 eolink_list_projects 获取）
  - keyword：搜索关键字（匹配名称/URL/Tag），可选
  - group_ids：分组 ID 数组，可选（先用 eolink_list_groups 拿）
  - api_status：状态过滤，可选
  - limit：返回数量上限（默认 30）

返回每个接口的 api_id（后续取详情要用）、api_name、api_path、method、group_name 等。`,
    inputSchema: SearchApisSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    const body: Record<string, unknown> = {};
    if (params.keyword) body.keyword = params.keyword;
    if (params.group_ids?.length) body.group_ids = params.group_ids;
    if (params.api_status) body.api_status = params.api_status;

    const resp = await eolinkRequest<{
      status: string;
      result?: Array<Record<string, unknown>>;
    }>("v2/api_studio/management/api/search", params.project_id, body);
    if (!isOk(resp)) {
      return errText("搜索接口失败", resp);
    }
    const all = resp.result ?? [];
    const items = all.slice(0, params.limit);
    const text = renderApiList(items, all.length, params.limit);
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        total: all.length,
        count: items.length,
        truncated: all.length > params.limit,
        items,
      },
    };
  }
);

// ---------------------------------------------------------------------------
// 工具 4：按 URL 精确查找接口
// ---------------------------------------------------------------------------
const FindApiByPathSchema = z
  .object({
    project_id: projectIdRequired,
    api_path: z
      .string()
      .min(1)
      .describe(
        "接口路径，如 user/user/list。可带前导斜杠，会自动归一化。匹配依据见 match_mode"
      ),
    match_mode: z
      .enum(["exact", "prefix"])
      .default("exact")
      .describe(
        "exact：api_path 完全相等；prefix：api_path 以给定值开头（用于按前缀批量找同模块接口）"
      ),
  })
  .strict();

server.registerTool(
  "eolink_find_api_by_path",
  {
    title: "按 URL 精确查找 Eolink 接口",
    description: `按接口路径（api_path）精确查找接口，规避 eolink_search_apis 的模糊分词噪声。

内部拉取项目下全部接口后在 server 端按 api_path 匹配，只返回真正匹配的接口。

参数：
  - project_id：项目 ID（必填）
  - api_path：接口路径，如 user/user/list（可带前导 /）
  - match_mode：exact=完全相等（默认），prefix=以给定值开头

返回匹配接口的 api_id、api_name、api_path、method 等。拿到 api_id 后用 eolink_get_api_detail 看完整定义。`,
    inputSchema: FindApiByPathSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    // 归一化：去前导/尾随斜杠
    const target = params.api_path.replace(/^\/+|\/+$/g, "");
    // 不传 keyword，拉项目下全部接口
    const resp = await eolinkRequest<{
      status: string;
      result?: Array<Record<string, unknown>>;
    }>("v2/api_studio/management/api/search", params.project_id, {});
    if (!isOk(resp)) {
      return errText("按路径查找接口失败（拉取全量接口失败）", resp);
    }
    const all = resp.result ?? [];
    const matched = all.filter((it) => {
      const p = String(it.api_path ?? "").replace(/^\/+|\/+$/g, "");
      return params.match_mode === "prefix" ? p.startsWith(target) : p === target;
    });
    const text = renderApiList(matched, matched.length, 100);
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        target,
        match_mode: params.match_mode,
        total_scanned: all.length,
        count: matched.length,
        items: matched,
      },
    };
  }
);

// ---------------------------------------------------------------------------
// 工具 5：获取接口详情
// ---------------------------------------------------------------------------
const ApiDetailSchema = z
  .object({
    project_id: projectIdRequired,
    api_id: z
      .number()
      .int()
      .describe("接口 ID，可从 eolink_search_apis 的结果获取"),
  })
  .strict();

server.registerTool(
  "eolink_get_api_detail",
  {
    title: "获取 Eolink 接口详情",
    description: `获取单个 HTTP 接口的完整定义：基础信息、请求头、query 参数、restful 参数、请求体参数、响应结构（含 mock 示例）。

参数：
  - project_id：项目 ID（必填）
  - api_id：接口 ID（先用 eolink_search_apis 搜索得到）

返回 Markdown 格式的接口文档，包含每个参数的名称、类型、是否必填、说明、示例值。`,
    inputSchema: ApiDetailSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    const resp = await eolinkRequest<{
      status: string;
      api_info?: Record<string, unknown>;
    }>("v2/api_studio/management/api/api_info", params.project_id, {
      api_id: params.api_id,
    });
    if (!isOk(resp) || !resp.api_info) {
      return errText("获取接口详情失败", resp);
    }
    const text = renderApiDetail(resp.api_info);
    const truncated = text.length > CHARACTER_LIMIT;
    const finalText = truncated
      ? text.slice(0, CHARACTER_LIMIT) +
        `\n\n[响应超过 ${CHARACTER_LIMIT} 字符，已截断。如需完整数据请用 JSON 格式或缩小查询范围。]`
      : text;
    return {
      content: [{ type: "text", text: finalText }],
      structuredContent: { api_id: params.api_id, truncated, api_info: resp.api_info },
    };
  }
);

// ---------------------------------------------------------------------------
// 工具 6：导出全量 OpenAPI（兜底）
// ---------------------------------------------------------------------------
const ExportSchema = z
  .object({
    project_id: projectIdRequired,
    group_ids: z
      .array(z.number().int())
      .optional()
      .describe("只导出指定分组；留空导出整个项目"),
  })
  .strict();

server.registerTool(
  "eolink_export_openapi",
  {
    title: "导出 Eolink 接口文档",
    description: `导出指定项目（或指定分组）的接口文档为 OpenAPI/Swagger JSON，适合一次性全量获取。

参数：
  - project_id：项目 ID（必填）
  - group_ids：可选，只导出指定分组

注意：全量导出可能很大，会自动按字符上限截断。日常查询单个接口建议用 eolink_search_apis + eolink_get_api_detail。`,
    inputSchema: ExportSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    const body: Record<string, unknown> = {};
    if (params.group_ids?.length) body.group_ids = params.group_ids;
    const resp = await eolinkRequest<Record<string, unknown>>(
      "v2/api_studio/management/api/export",
      params.project_id,
      body
    );
    const text = JSON.stringify(resp, null, 2);
    const truncated = text.length > CHARACTER_LIMIT;
    const finalText = truncated
      ? text.slice(0, CHARACTER_LIMIT) +
        `\n\n[已截断，完整文档请缩小 group_ids 范围或改用单接口查询]`
      : text;
    return {
      content: [{ type: "text", text: finalText }],
      structuredContent: { truncated, data: resp },
    };
  }
);

// ---------------------------------------------------------------------------
// 工具 7 & 8：新增 / 修改接口（共用 schema，差异在 api_id 是否必填）
// ---------------------------------------------------------------------------

/** 单个参数的 Zod 片段（query/body/restful 通用） */
const ParamItemSchema = z
  .object({
    param_key: z.string().describe("参数名，如 limit"),
    param_name: z.string().optional().describe("参数说明/中文名"),
    param_type: z
      .string()
      .describe("参数类型数字：0=string 1=file 2=json 3=int 4=float 6=date 7=datetime 8=boolean"),
    param_not_null: z
      .enum(["0", "1"])
      .default("0")
      .describe("是否必填：1=是 0=否"),
    param_value: z.string().optional().describe("参数示例值"),
    param_note: z.string().optional().describe("备注"),
  })
  .strict();

/** 写接口的请求/响应参数项（不含 project_id，由各工具 extend 加入） */
const ApiWriteFields = {
  api_name: z.string().min(1).describe("接口名称"),
  api_url: z.string().min(1).describe("接口 URL，如 user/user/list"),
  group_id: z.number().int().describe("分组 ID（先用 eolink_list_groups 获取）"),
  api_request_type: z
    .enum(["get", "post", "put", "delete", "patch", "head", "options"])
    .describe("请求方法"),
  api_protocol: z.enum(["http", "https"]).default("http").describe("请求协议"),
  api_status: z
    .enum(["enable", "disable"])
    .default("enable")
    .describe("接口状态：enable=已启用 disable=已禁用"),
  api_success_mock: z.string().optional().describe("成功响应示例（JSON 字符串）"),
  api_failure_mock: z.string().optional().describe("失败响应示例（JSON 字符串）"),
  api_url_param: z
    .array(ParamItemSchema)
    .optional()
    .describe("Query 参数列表"),
  api_request_param: z
    .array(ParamItemSchema)
    .optional()
    .describe("请求体参数列表"),
  api_restful_param: z
    .array(ParamItemSchema)
    .optional()
    .describe("Restful 路径参数列表"),
  api_note: z.string().optional().describe("接口详细说明（markdown）"),
};

/** 把工具参数组装成 Eolink create_or_update_http_api 的 body */
function buildWriteBody(params: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    api_name: params.api_name,
    api_url: params.api_url,
    group_id: params.group_id,
    api_request_type: params.api_request_type,
    api_protocol: params.api_protocol,
    api_status: params.api_status,
  };
  if (params.api_success_mock !== undefined) body.api_success_mock = params.api_success_mock;
  if (params.api_failure_mock !== undefined) body.api_failure_mock = params.api_failure_mock;
  if (params.api_url_param !== undefined) body.api_url_param = params.api_url_param;
  if (params.api_request_param !== undefined) body.api_request_param = params.api_request_param;
  if (params.api_restful_param !== undefined) body.api_restful_param = params.api_restful_param;
  if (params.api_note !== undefined) body.api_note = params.api_note;
  return body;
}

// ---- 工具 7：新增接口 ----
const CreateApiSchema = z
  .object({ project_id: projectIdRequired, ...ApiWriteFields })
  .strict();

server.registerTool(
  "eolink_create_api",
  {
    title: "新增 Eolink 接口",
    description: `在指定项目里新增一个 HTTP 接口文档（调用 create_or_update_http_api，不传 api_id）。

⚠️ 写操作：会直接在 Eolink 项目里创建新接口。

参数：
  - project_id：项目 ID（必填）
  - api_name：接口名称（必填）
  - api_url：接口 URL（必填）
  - group_id：分组 ID（必填，先用 eolink_list_groups 获取）
  - api_request_type：请求方法 get/post/put/delete/patch 等（必填）
  - api_protocol：http 或 https（默认 http）
  - api_status：enable/disable（默认 enable）
  - api_url_param：Query 参数列表（可选）
  - api_request_param：请求体参数列表（可选）
  - api_restful_param：Restful 路径参数列表（可选）
  - api_success_mock / api_failure_mock：响应示例（可选）
  - api_note：接口说明 markdown（可选）

参数类型 param_type 用数字：0=string 3=int 2=json 8=boolean 等。
返回新接口的 api_id。`,
    inputSchema: CreateApiSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    const body = buildWriteBody(params);
    const resp = await eolinkRequest<{ status: string; data?: Record<string, unknown> }>(
      "v2/api_studio/management/api/create_or_update_http_api",
      params.project_id,
      body,
      false,
      true
    );
    if (!isOk(resp)) {
      return errText("新增接口失败", resp);
    }
    const apiId = resp.data?.apiID ?? resp.data?.api_id;
    return {
      content: [
        {
          type: "text",
          text: `✅ 已新增接口：${params.api_name}\n  api_id: ${apiId ?? "(未返回)"}\n  URL: ${params.api_protocol}://${params.api_url}\n  分组: ${params.group_id}\n用 eolink_get_api_detail 查看完整定义。`,
        },
      ],
      structuredContent: { api_id: apiId, api_name: params.api_name, data: resp.data },
    };
  }
);

// ---- 工具 8：修改接口 ----
const UpdateApiSchema = z
  .object({
    project_id: projectIdRequired,
    api_id: z
      .number()
      .int()
      .describe("要修改的接口 ID（先用 eolink_search_apis 或 find_api_by_path 获取）"),
    ...ApiWriteFields,
  })
  .strict();

server.registerTool(
  "eolink_update_api",
  {
    title: "修改 Eolink 接口",
    description: `修改指定项目里一个已存在的 HTTP 接口（调用 create_or_update_http_api，传 api_id）。

⚠️ 写操作：会直接改动 Eolink 里已有的接口文档。建议先用 eolink_get_api_detail 确认当前内容再改。

参数：
  - project_id：项目 ID（必填）
  - api_id：要修改的接口 ID（必填）
  - 其余字段同 eolink_create_api（api_name/api_url/group_id/请求方法/参数等）

注意：传哪些字段就改哪些字段，未传的字段保持原值？—— 实际 Eolink 对未传字段的处理依实现而定，
建议修改前先 get_api_detail 拿到完整内容，再把要保留的字段一并传入。

返回更新后的接口信息。`,
    inputSchema: UpdateApiSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    const body = buildWriteBody(params);
    body.api_id = params.api_id;
    const resp = await eolinkRequest<{ status: string; data?: Record<string, unknown> }>(
      "v2/api_studio/management/api/create_or_update_http_api",
      params.project_id,
      body,
      false,
      true
    );
    if (!isOk(resp)) {
      return errText("修改接口失败", resp);
    }
    return {
      content: [
        {
          type: "text",
          text: `✅ 已修改接口 api_id=${params.api_id}：${params.api_name}\n  URL: ${params.api_protocol}://${params.api_url}\n用 eolink_get_api_detail 查看修改后的完整定义。`,
        },
      ],
      structuredContent: { api_id: params.api_id, data: resp.data },
    };
  }
);

// ---------------------------------------------------------------------------
// 工具 9：新增分组
// ---------------------------------------------------------------------------
const CreateGroupSchema = z
  .object({
    project_id: projectIdRequired,
    group_name: z.string().min(1).describe("分组名称"),
    parent_group_id: z
      .number()
      .int()
      .default(0)
      .describe(
        "父级分组 ID，默认 0 表示顶级分组。传具体 group_id 则创建为子分组"
      ),
  })
  .strict();

server.registerTool(
  "eolink_create_group",
  {
    title: "新增 Eolink 接口分组",
    description: `在指定项目里新增一个 API 文档分组。

注意：add_group 接口不支持 JSON，使用 form-urlencoded 格式（已内置处理）。

参数：
  - project_id：项目 ID（必填）
  - group_name：分组名称（必填）
  - parent_group_id：父分组 ID（可选，默认 0=顶级分组）

返回新创建的分组 group_id。用 eolink_list_groups 验证分组是否出现在树上。`,
    inputSchema: CreateGroupSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params) => {
    const resp = await eolinkRequest<{ status: string; data?: number }>(
      "v2/api_studio/management/api/add_group",
      params.project_id,
      { group_name: params.group_name, parent_group_id: params.parent_group_id },
      false,
      false,
      true // form-urlencoded
    );
    if (!isOk(resp)) {
      return errText("新增分组失败", resp);
    }
    return {
      content: [
        {
          type: "text",
          text: `✅ 已新增分组：${params.group_name}\n  group_id: ${resp.data ?? "(未返回)"}\n  父分组: ${params.parent_group_id === 0 ? "顶级" : params.parent_group_id}\n  项目: ${params.project_id}\n用 eolink_list_groups 查看分组树。`,
        },
      ],
      structuredContent: {
        group_id: resp.data,
        group_name: params.group_name,
      },
    };
  }
);

// ---------------------------------------------------------------------------
// 渲染辅助函数
// ---------------------------------------------------------------------------
function errText(action: string, resp: unknown): { content: [{ type: "text"; text: string }] } {
  return {
    content: [
      { type: "text", text: `${action}。Eolink 返回：${JSON.stringify(resp).slice(0, 500)}` },
    ],
  };
}

/** 把项目列表渲染成可读 Markdown */
function renderProjects(items: unknown[]): string {
  if (!items?.length) return "（该工作空间没有项目）";
  const lines: string[] = ["# Eolink 项目列表", ""];
  for (const p of items as Array<Record<string, unknown>>) {
    const archived = p.is_archive && p.is_archive !== 0 ? " [已归档]" : "";
    lines.push(
      `- **${p.project_name}**${archived}\n  project_id: \`${p.project_id}\`` +
        (p.creator ? `\n  创建人: ${p.creator}` : "")
    );
  }
  lines.push(
    "",
    "选定一个 project_id，在 list_groups / search_apis / get_api_detail / export_openapi 调用时显式传入。"
  );
  return lines.join("\n");
}

/** 把分组树渲染成可读 Markdown */
function renderGroups(groups: unknown[]): string {
  if (!groups?.length) return "（该项目没有接口分组）";
  const lines: string[] = ["# Eolink 接口分组", ""];
  const walk = (list: unknown[], depth: number): void => {
    for (const g of list as Array<Record<string, unknown>>) {
      const indent = "  ".repeat(depth);
      lines.push(`${indent}- [${g.group_id}] ${g.group_name}`);
      if (Array.isArray(g.group_child_list) && g.group_child_list.length) {
        walk(g.group_child_list, depth + 1);
      }
    }
  };
  walk(groups, 0);
  lines.push("", `共 ${countGroups(groups)} 个分组。用 group_id 作为 eolink_search_apis 的 group_ids 参数。`);
  return lines.join("\n");
}

function countGroups(groups: unknown[]): number {
  let n = 0;
  for (const g of groups as Array<Record<string, unknown>>) {
    n += 1;
    if (Array.isArray(g.group_child_list)) n += countGroups(g.group_child_list);
  }
  return n;
}

/** 把接口列表渲染成可读 Markdown */
function renderApiList(
  items: Array<Record<string, unknown>>,
  total: number,
  limit: number
): string {
  if (!items.length) return "没有匹配的接口。";
  const lines: string[] = [`# 接口搜索结果（共 ${total} 条${total > limit ? `，显示前 ${limit} 条` : ""}）`, ""];
  for (const it of items) {
    const method = String(it.method ?? "").toUpperCase().padEnd(6);
    lines.push(`- **[${it.api_id}] ${it.api_name}**  \`${method} ${it.api_path}\``);
    if (it.group_name) lines.push(`  分组：${it.group_name}`);
  }
  lines.push("", "取某个接口的 api_id，用 eolink_get_api_detail 获取完整定义。");
  return lines.join("\n");
}

/** 把单个接口详情渲染成可读 Markdown 文档 */
function renderApiDetail(info: Record<string, unknown>): string {
  const base = (info.base_info as Record<string, unknown>) ?? {};
  const lines: string[] = [];
  lines.push(`# ${base.api_name ?? "(未命名接口)"}`);
  lines.push("");
  lines.push(`- **URL**: \`${String(base.api_request_type ?? "").toUpperCase()} ${base.api_protocol}://${base.api_url}\``);
  lines.push(`- **状态**: ${base.api_status}`);
  lines.push(`- **分组 ID**: ${base.group_id}`);
  if (base.api_tag) lines.push(`- **标签**: ${base.api_tag}`);

  const paramType = base.api_request_param_type;
  lines.push("", `## 请求参数（类型：${paramType}）`);

  renderParamSection(lines, "Query 参数", info.url_param);
  renderParamSection(lines, "Restful 参数", info.restful_param);
  renderParamSection(lines, "请求体参数", info.request_info);
  renderParamSection(lines, "请求头", info.header_info);

  const results = info.result_info as Array<Record<string, unknown>> | undefined;
  lines.push("", "## 响应");
  if (results?.length) {
    for (const r of results) {
      lines.push(`### ${r.response_name ?? "响应"}（状态码 ${r.response_code ?? "-"}，类型 ${r.response_type}）`);
      if (Array.isArray(r.param_list) && r.param_list.length) {
        renderParamSection(lines, "响应字段", r.param_list);
      }
      if (r.raw) lines.push("", "**Raw 示例**:", "```json", String(r.raw), "```");
    }
  }

  if (base.api_success_mock) {
    lines.push("", "## 成功响应示例（Mock）", "```json", String(base.api_success_mock), "```");
  }
  if (base.api_failure_mock) {
    lines.push("", "## 失败响应示例（Mock）", "```json", String(base.api_failure_mock), "```");
  }
  return lines.join("\n");
}

/** 渲染一个参数区块（参数可能是对象或数组） */
function renderParamSection(
  lines: string[],
  title: string,
  params: unknown
): void {
  if (!params) return;
  const arr = Array.isArray(params) ? params : [params];
  if (!arr.length) return;
  lines.push("", `### ${title}`, "| 参数名 | 类型 | 必填 | 说明 | 示例 |", "| --- | --- | --- | --- | --- |");
  for (const p of arr as Array<Record<string, unknown>>) {
    const req = p.param_not_null === "1" || p.param_not_null === "true" ? "是" : "否";
    lines.push(
      `| ${p.param_key ?? p.header_name ?? ""} | ${p.param_type ?? p.header_value ?? ""} | ${req} | ${p.param_name ?? ""} | ${p.param_value ?? p.default ?? ""} |`
    );
    if (Array.isArray(p.child_list) && p.child_list.length) {
      renderParamSection(lines, `${title} > ${p.param_key}（子参数）`, p.child_list);
    }
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("eolink-mcp-server v1.2.0 running via stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
