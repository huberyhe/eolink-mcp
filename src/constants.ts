/**
 * Eolink MCP server 共享常量。
 * 凭证从环境变量读取，不硬编码、不进仓库。
 */

/**
 * Eolink 实例的 Open API 基础地址（不含末尾斜杠）。
 * 无默认值——必须由使用者通过 EOLINK_BASE_URL 环境变量传入，
 * 这样包不绑定任何特定部署/内网，对 SaaS 和私有化都通用。
 */
export const API_BASE_URL = process.env.EOLINK_BASE_URL ?? "";

/** Open API 鉴权令牌（请求头 Eo-Secret-Key） */
export const EO_SECRET_KEY = process.env.EOLINK_TOKEN ?? "";

/** 工作空间 ID（space_id） */
export const SPACE_ID = process.env.EOLINK_SPACE_ID ?? "";

/** 单次返回的字符上限，防止响应撑爆 LLM 上下文 */
export const CHARACTER_LIMIT = 25000;

/** 请求超时（毫秒） */
export const REQUEST_TIMEOUT = 30000;

/**
 * 代理配置：Node 的 axios 默认不读系统 HTTP(S)_PROXY 环境变量，
 * 而访问 Eolink 实例（尤其私有化内网部署）常需经代理（curl 会自动走，axios 不会）。
 * 这里把常见代理 env 透传给 axios。设 EOLINK_NO_PROXY=1 可禁用。
 */
export function resolveProxy(): { host: string; port: number } | undefined {
  if (process.env.EOLINK_NO_PROXY === "1") return undefined;
  const raw =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (!raw) return undefined;
  // 支持 http://host:port 和 socks5://host:port（axios 用 https-proxy-agent 也能处理 http 代理）
  try {
    const url = new URL(raw);
    const port = url.port ? parseInt(url.port) : url.protocol === "https:" ? 443 : 80;
    return { host: url.hostname, port };
  } catch {
    return undefined;
  }
}

/** 校验必需凭证已注入（project_id 由工具参数动态传入，不在此校验） */
export function assertConfig(): void {
  const missing: string[] = [];
  if (!API_BASE_URL) missing.push("EOLINK_BASE_URL");
  if (!EO_SECRET_KEY) missing.push("EOLINK_TOKEN");
  if (!SPACE_ID) missing.push("EOLINK_SPACE_ID");
  if (missing.length > 0) {
    console.error(
      `ERROR: 缺少必需环境变量: ${missing.join(", ")}。\n` +
        `请在 MCP 客户端的 env 配置中设置：\n` +
        `  EOLINK_BASE_URL  — Eolink 实例 Open API 地址（如 https://your-eolink.example.com）\n` +
        `  EOLINK_TOKEN     — Open API 令牌（对应请求头 Eo-Secret-Key）\n` +
        `  EOLINK_SPACE_ID  — 工作空间 ID\n` +
        `project_id 不在此配置，用 eolink_list_projects 动态选择后传给各工具。`
    );
    process.exit(1);
  }
}
