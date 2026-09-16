/**
 * Eolink MCP server 共享常量。
 * 凭证从环境变量读取，不硬编码、不进仓库。
 */

/** 当前版本号，server 注册与启动日志共用，避免两处漂移 */
export const VERSION = "1.1.1";

/**
 * Eolink 实例的 Open API 基础地址（不含末尾斜杠）。
 * 无默认值——必须由使用者通过 EOLINK_BASE_URL 环境变量传入，
 * 这样包不绑定任何特定部署/内网，对 SaaS 和私有化都通用。
 *
 * 这里 trim 并去掉尾随斜杠：配置里手抄 URL 常带空格或末尾 `/`，
 * 会导致拼接出 `//v2/...` 这类畸形路径而被网关拒绝。
 */
export const API_BASE_URL = normalizeBaseUrl(process.env.EOLINK_BASE_URL ?? "");

/**
 * Open API 鉴权令牌（请求头 Eo-Secret-Key）。
 * trim 掉首尾空白：从后台复制令牌时极易带上换行/空格，
 * 而网关对格式错误一律回 200007，表现为「token 明明填了却说格式错」。
 */
export const EO_SECRET_KEY = (process.env.EOLINK_TOKEN ?? "").trim();

/** 工作空间 ID（space_id）。同样 trim，理由同上。 */
export const SPACE_ID = (process.env.EOLINK_SPACE_ID ?? "").trim();

/** 去掉首尾空白与尾随斜杠，得到干净的 base url */
function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * 把敏感值遮蔽成可安全展示的形态（如 `abcd…wxyz`），
 * 用于自检工具输出——绝不回显完整令牌。
 */
export function maskSecret(value: string): string {
  if (!value) return "(未设置)";
  // 阈值取 16：低于此长度时「首 4 + 尾 4」会暴露过半内容（如 9 字符会显示 8 个），
  // 对短令牌/短 space_id 等于半明文，故一律全遮。
  if (value.length < 16) return `*`.repeat(value.length) + `（共 ${value.length} 字符）`;
  return `${value.slice(0, 4)}…${value.slice(-4)}（共 ${value.length} 字符）`;
}

/**
 * 是否在启动时联网校验凭据有效性（token / space_id）。
 * 默认关闭——启动时联网探测会拖慢启动，且内网/代理未就绪或 Eolink 抖动时
 * 会把「临时不可达」误判成「配置错误」而拒绝启动。
 * 需要时设 EOLINK_VERIFY_ON_START=1 开启。
 */
export const VERIFY_ON_START = process.env.EOLINK_VERIFY_ON_START === "1";

/** 启动探测的超时（毫秒）。取较短值，避免拖慢启动 */
export const VERIFY_TIMEOUT = 5000;

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

/** 判断是否形如 http(s)://host 的合法地址 */
function isValidBaseUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    return Boolean(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * 校验必需凭证已注入（project_id 由工具参数动态传入，不在此校验）。
 *
 * 保持 fail-fast：配置缺失时直接退出，避免带着坏配置去发请求。
 * 提示写成单行密集形式——stdio 客户端通常只回显 stderr 首行或摘要。
 *
 * 注意这里只校验「本地可判定」的问题（缺失、URL 非法）；
 * token / space_id 的真实有效性必须联网才能确认，交给 eolink_health_check。
 */
export function assertConfig(): void {
  const missing: string[] = [];
  if (!API_BASE_URL) missing.push("EOLINK_BASE_URL");
  if (!EO_SECRET_KEY) missing.push("EOLINK_TOKEN");
  if (!SPACE_ID) missing.push("EOLINK_SPACE_ID");
  if (missing.length > 0) {
    console.error(
      `ERROR: eolink-mcp 缺少必需环境变量: ${missing.join(", ")}。` +
        `请在 MCP 客户端配置的 env 中补齐——` +
        `EOLINK_BASE_URL=https://your-eolink.example.com（实例 Open API 根地址）、` +
        `EOLINK_TOKEN=<开放 API 令牌，即请求头 Eo-Secret-Key>、` +
        `EOLINK_SPACE_ID=<工作空间 ID>。` +
        `project_id 不在此配置，用 eolink_list_projects 动态选择后传给各工具。`
    );
    process.exit(1);
  }
  if (!isValidBaseUrl(API_BASE_URL)) {
    console.error(
      `ERROR: eolink-mcp 的 EOLINK_BASE_URL 不是合法地址: "${API_BASE_URL}"。` +
        `应为带协议的 Open API 根地址，如 https://your-eolink.example.com（不要末尾斜杠）。`
    );
    process.exit(1);
  }
  // token 形态告警（非阻断）：太短基本可断定没填完整
  if (EO_SECRET_KEY.length < 16) {
    console.error(
      `WARN: eolink-mcp 的 EOLINK_TOKEN 仅 ${EO_SECRET_KEY.length} 字符，疑似未填完整。` +
        `请在 Eolink 后台『空间设置 / 开放 API』重新生成；填错时网关会返回 code 200007。`
    );
  }
}
