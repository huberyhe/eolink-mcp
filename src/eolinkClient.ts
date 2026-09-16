/**
 * Eolink Open API 客户端。
 *
 * 认证模型（已通过 curl 验证）：
 * - 请求头 Eo-Secret-Key: <Open API 令牌>
 * - Body(JSON) 必填 space_id + project_id
 * - 网关对成功请求会返回 HTTP 302，但 body 仍是合法 JSON ——
 *   maxRedirects:0 + validateStatus 接受 302，直接解析 body。
 *
 * project_id 不来自环境变量、不保存在内存态，每次调用由工具参数显式传入。
 * 代理：Node 的 axios 默认不读 HTTP(S)_PROXY 环境变量，而本机访问私有
 * 实例必须经代理，这里显式把代理透传给 axios。
 */
import axios, { AxiosError, AxiosProxyConfig } from "axios";
import {
  API_BASE_URL,
  EO_SECRET_KEY,
  REQUEST_TIMEOUT,
  SPACE_ID,
  resolveProxy,
} from "./constants.js";

/** 超时/连接类错误的重试次数（不含首次），应对代理间歇性抖动 */
const RETRY_TIMES = 2;

/**
 * 响应体大小上限（字节）。axios 默认 -1（无限），
 * 全量导出遇到超大项目时可能把内存和 stdio 通道一起拖垮，这里设个上限让它快速失败。
 * 取 64MB：实测单项目 export 可达 12MB，留足余量，同时仍能挡住失控响应。
 */
const MAX_CONTENT_LENGTH = 64 * 1024 * 1024;

/** 错误归类，便于生成可操作的提示 */
export type ErrorKind =
  | "auth"
  | "space"
  | "project"
  | "permission"
  | "timeout"
  | "network"
  | "business";

/**
 * Eolink 业务/配置类错误。
 *
 * 由 eolinkRequest 在响应体 status !== "success" 时抛出——抛异常而非返回，
 * 是为了让 MCP SDK 自动补上 isError: true，客户端才能拿到正确的错误语义。
 */
export class EolinkError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly code?: string
  ) {
    super(message);
    this.name = "EolinkError";
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof AxiosError) {
    // 注意：不含 ENOTFOUND——DNS 解析失败重试无意义，应立即暴露。
    return (
      error.code === "ECONNABORTED" ||
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNRESET" ||
      error.code === "ECONNREFUSED"
    );
  }
  return false;
}

/**
 * 把 Eolink 返回体里的错误归类成可操作的中文提示。
 *
 * 实测错误形态：
 *   token 错误      → {"type":"customizeCodeException","status":"error","code":"200007",
 *                      "error_info":"request header parameter Eo-Secret-Key is incorrect.(wrong format)"}
 *   project_id 错误 → {"type":"BaseException","status":"error","code":"200301",
 *                      "error_info":"project_id is not in the correct format"}
 */
function classifyEolinkError(
  body: Record<string, unknown>,
  path: string
): EolinkError {
  const code = typeof body.code === "string" ? body.code : undefined;
  const info = typeof body.error_info === "string" ? body.error_info : "";
  const detail = `Eolink 返回：code=${code ?? "-"} ${info || JSON.stringify(body).slice(0, 200)}`;

  // 鉴权失败：实测 code 200007，error_info 指向 Eo-Secret-Key
  if (code === "200007" || /Eo-Secret-Key/i.test(info)) {
    return new EolinkError(
      `Eolink 鉴权失败：EOLINK_TOKEN 无效或未传。` +
        `请到 Eolink 后台『空间设置 / 开放 API』重新生成令牌，` +
        `确认 MCP 配置里的 EOLINK_TOKEN 与该空间匹配、且没有多余空格或换行。${detail}`,
      "auth",
      code
    );
  }
  // 工作空间无效 / 无权限
  if (/space/i.test(info) || code === "200008") {
    return new EolinkError(
      `Eolink 空间校验失败：请确认 EOLINK_SPACE_ID 正确，且该令牌对该空间有访问权限。${detail}`,
      "space",
      code
    );
  }
  // project_id 格式/归属错误
  if (code === "200301" || /project_id/i.test(info)) {
    return new EolinkError(
      `Eolink 项目校验失败：project_id 无效或不属于该空间。` +
        `请先用 eolink_list_projects 查看可选项目，再把正确的 project_id 传给本工具。${detail}`,
      "project",
      code
    );
  }
  if (/permission|forbidden|denied|权限/i.test(info)) {
    return new EolinkError(
      `Eolink 权限不足：当前令牌无权执行该操作（写操作需相应权限）。${detail}`,
      "permission",
      code
    );
  }
  return new EolinkError(`Eolink 接口调用失败 (path=${path})。${detail}`, "business", code);
}

/**
 * 发起一次 Eolink Open API 调用。
 * @param path      接口路径，如 "v2/api_studio/management/api/search"
 * @param projectId 项目 ID（除 project/search 外都必传）
 * @param opts      可选配置
 */
export async function eolinkRequest<T = unknown>(
  path: string,
  projectId: string | undefined,
  opts: {
    extra?: Record<string, unknown>;
    noProject?: boolean;
    write?: boolean;
    form?: boolean;
    /** 覆盖默认超时（毫秒）。启动探测用更短的值，避免拖慢启动 */
    timeout?: number;
    /** 覆盖默认重试次数。启动探测设 0，不等待重试 */
    retryTimes?: number;
  } = {}
): Promise<T> {
  const {
    extra = {},
    noProject = false,
    write = false,
    form = false,
    timeout = REQUEST_TIMEOUT,
    retryTimes = RETRY_TIMES,
  } = opts;
  const cleanPath = path.replace(/^\//, "");
  // 写操作需要 /index.php/ 前缀，读操作直接 /path
  const prefix = write ? "index.php/" : "";
  const url = `${API_BASE_URL}/${prefix}${cleanPath}`;
  const body: Record<string, unknown> = { space_id: SPACE_ID, ...extra };
  if (!noProject) {
    if (!projectId || !projectId.trim()) {
      throw new Error(
        "未提供 project_id。请先用 eolink_list_projects 查看可选项目，再在本工具调用时显式传 project_id 参数。"
      );
    }
    body.project_id = projectId.trim();
  }
  const proxy = resolveProxy();
  const proxyConfig: AxiosProxyConfig | false = proxy
    ? { host: proxy.host, port: proxy.port, protocol: "http" }
    : false;

  // form 模式：用 URLSearchParams 编码（比手动 encodeURIComponent 更标准）
  const contentType = form ? "application/x-www-form-urlencoded" : "application/json";
  const sendData = form
    ? new URLSearchParams(
        Object.fromEntries(
          Object.entries(body).map(([k, v]) => [k, String(v)])
        )
      ).toString()
    : body;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retryTimes; attempt++) {
    try {
      const resp = await axios.request<T>({
        method: "POST",
        url,
        data: sendData,
        timeout,
        maxContentLength: MAX_CONTENT_LENGTH,
        headers: {
          "Content-Type": contentType,
          Accept: "application/json",
          "Eo-Secret-Key": EO_SECRET_KEY,
        },
        proxy: proxyConfig,
        maxRedirects: 0,
        validateStatus: (s) => s < 400 || s === 302,
      });
      // 关键：网关对「成功」和「鉴权失败」都返回 302，因此 302 不是成功判据，
      // 唯一可靠的判据是响应体里的 status 字段。此处集中判定，
      // 让所有工具（含此前漏校验的 export_openapi）都能正确报错。
      // 无 status 字段的响应（如 export 的裸 OpenAPI 结构）视为成功，保持既有行为。
      const data = normalizeResponse(resp.data, resp.status, path);
      if (
        typeof (data as { status?: unknown }).status === "string" &&
        (data as { status: string }).status !== "success"
      ) {
        throw classifyEolinkError(data as Record<string, unknown>, path);
      }
      return data as T;
    } catch (error) {
      // EolinkError 是业务/配置类错误，重试无意义，直接抛出
      if (error instanceof EolinkError) throw error;
      lastError = error;
      // 仅对超时/连接类错误重试；HTTP 4xx/5xx 业务错误不重试
      if (!isRetryable(error) || attempt === retryTimes) break;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw new Error(formatAxiosError(lastError, path));
}

/**
 * 归一化响应体。
 *
 * axios 默认的 transformResponse 只看「是不是字符串」，**不看 Content-Type**，
 * 且 silentJSONParsing 默认开启，所以：
 * - 合法 JSON（即便 Content-Type 是 application/amsp 这类非标准值）已被解析成对象，
 *   本函数直接原样返回；
 * - `resp.data` 仍是字符串，说明 axios 的 JSON.parse 已失败——典型是 HTML 登录页/
 *   网关页，或响应根本不是 JSON。
 *
 * 所以这里对字符串再尝试一次 parse（防御性，正常不会走到），
 * 失败才判定为响应异常，提示核对 EOLINK_BASE_URL。
 */
function normalizeResponse(raw: unknown, httpStatus: number, path: string): unknown {
  if (raw !== null && typeof raw === "object") return raw;
  // 裸 null / undefined 无 status 可判，直接当空对象，避免调用处 data.status 抛 TypeError
  if (raw === null || raw === undefined) return {};
  const text = typeof raw === "string" ? raw : String(raw);
  try {
    const parsed = JSON.parse(text);
    // 解析成 null 或标量（如 42）时同样没有 status 字段可判，归一成空对象
    return parsed === null || typeof parsed !== "object" ? {} : parsed;
  } catch {
    throw new EolinkError(
      `Eolink 响应不是预期的 JSON（HTTP ${httpStatus}）：` +
        `请确认 EOLINK_BASE_URL 指向 Open API 根地址（如 https://your-eolink.example.com，` +
        `不要带 /v2 路径或末尾斜杠）。path=${path} 响应片段=${text.slice(0, 120)}`,
      "network"
    );
  }
}

/** 把 axios 错误转成对 agent 友好的可操作提示 */
function formatAxiosError(error: unknown, path: string): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const { status, data } = error.response;
      const body = typeof data === "string" ? data : JSON.stringify(data);
      if (status === 401 || status === 403) {
        return `Eolink 鉴权失败 (HTTP ${status})：请检查 EOLINK_TOKEN 是否正确、是否对该空间/项目有读权限。path=${path} body=${body.slice(0, 200)}`;
      }
      // 返回 HTML 通常意味着 base_url 指到了网页地址而非 Open API 根地址
      if (/^\s*<(!doctype|html)/i.test(body)) {
        return `Eolink 返回了 HTML 而非 JSON (HTTP ${status})：请确认 EOLINK_BASE_URL 指向 Open API 根地址（如 https://your-eolink.example.com），不要带 /v2 路径或末尾斜杠。path=${path}`;
      }
      return `Eolink 接口调用失败 (HTTP ${status})：path=${path} body=${body.slice(0, 200)}`;
    }
    if (error.code === "ECONNABORTED") {
      return `Eolink 请求超时：path=${path}（实例可能不可达，确认内网连通；若全空间搜索请缩小范围）`;
    }
    if (error.code === "ENOTFOUND") {
      return `Eolink 域名无法解析 (ENOTFOUND)：确认 EOLINK_BASE_URL 的域名正确、DNS 可用（当前值已脱敏，请核对配置）。`;
    }
    if (error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT") {
      return `Eolink 实例不可达 (${error.code})：确认 EOLINK_BASE_URL 正确、内网可访问，且代理（${process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "未设置"}）可用。`;
    }
    // ECONNRESET / TLS 握手失败：域名解析不到、端口不通、或代理/网关中断了连接
    if (error.code === "ECONNRESET" || error.code === "EPROTO" || error.code === "ERR_SSL_WRONG_VERSION_NUMBER") {
      return `Eolink 连接被中断 (${error.code})：通常是域名不存在、端口不通，或代理/网关拒绝连接。` +
        `请确认 EOLINK_BASE_URL 正确、内网可达，代理（${process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "未设置"}）可用。`;
    }
    // axios 在响应体超过 maxContentLength 时也抛 ERR_BAD_RESPONSE（且不带 response），
    // 必须与「真返回了非 JSON」区分，否则会把「响应过大」误导成「base_url 配错」。
    if (error.code === "ERR_BAD_RESPONSE" && /maxContentLength/i.test(error.message)) {
      return (
        `Eolink 响应过大，超过 ${Math.round(MAX_CONTENT_LENGTH / 1024 / 1024)}MB 上限被中止：path=${path}。` +
        `请缩小查询范围（如 export_openapi 传 group_ids 只导出部分分组，或改用 search_apis + get_api_detail 按需取）。`
      );
    }
    // 其余 ERR_BAD_RESPONSE：响应不是可解析的 JSON
    if (error.code === "ERR_BAD_RESPONSE") {
      return `Eolink 响应不是预期 JSON：检查 EOLINK_BASE_URL 是否指向 Open API 根地址（如 https://your-eolink.example.com，不要带 /v2 或末尾斜杠）。path=${path}`;
    }
  }
  return `Eolink 调用未知错误：path=${path} ${error instanceof Error ? error.message : String(error)}`;
}

/** 统一判断 Eolink 返回体里的 status 字段是否成功 */
export function isOk(resp: { status?: string }): boolean {
  return resp?.status === "success";
}

/**
 * 联网校验凭据有效性：调用最轻量的 project/search 探针。
 * 能返回即说明 base_url / token / space_id 三者全部有效。
 *
 * 启动自检（EOLINK_VERIFY_ON_START=1）与 eolink_health_check 共用本函数。
 * 不抛异常，而是把结论放在返回值里，便于调用方决定如何呈现。
 */
export async function verifyCredentials(opts: { timeout?: number } = {}): Promise<
  { ok: true; projectCount: number } | { ok: false; error: string }
> {
  try {
    const resp = await eolinkRequest<{ status: string; result?: unknown[] }>(
      "v2/api_studio/management/project/search",
      undefined,
      { noProject: true, timeout: opts.timeout, retryTimes: 0 }
    );
    if (!isOk(resp)) {
      return { ok: false, error: `探针返回非 success：${JSON.stringify(resp).slice(0, 300)}` };
    }
    return { ok: true, projectCount: resp.result?.length ?? 0 };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
