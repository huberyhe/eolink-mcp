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

/**
 * 发起一次 Eolink Open API 调用。
 * @param path        接口路径，如 "v2/api_studio/management/api/search"
 * @param projectId   项目 ID（除 project/search 外都必传）
 * @param extra       额外的 Body 字段（与 space_id/project_id 合并）
 * @param noProject   某些接口（如 project/search）不需要 project_id，置 true 跳过
 */
export async function eolinkRequest<T = unknown>(
  path: string,
  projectId: string | undefined,
  extra: Record<string, unknown> = {},
  noProject = false
): Promise<T> {
  const url = `${API_BASE_URL}/${path.replace(/^\//, "")}`;
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
  try {
    const resp = await axios.request<T>({
      method: "POST",
      url,
      data: body,
      timeout: REQUEST_TIMEOUT,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Eo-Secret-Key": EO_SECRET_KEY,
      },
      proxy: proxyConfig,
      maxRedirects: 0,
      validateStatus: (s) => s < 400 || s === 302,
    });
    return resp.data;
  } catch (error) {
    throw new Error(formatAxiosError(error, path));
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
      return `Eolink 接口调用失败 (HTTP ${status})：path=${path} body=${body.slice(0, 200)}`;
    }
    if (error.code === "ECONNABORTED") {
      return `Eolink 请求超时：path=${path}（实例可能不可达，确认内网连通；若全空间搜索请缩小范围）`;
    }
    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT") {
      return `Eolink 实例不可达 (${error.code})：确认 EOLINK_BASE_URL 正确、内网可访问，且代理（${process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "未设置"}）可用。`;
    }
  }
  return `Eolink 调用未知错误：path=${path} ${error instanceof Error ? error.message : String(error)}`;
}

/** 统一判断 Eolink 返回体里的 status 字段是否成功 */
export function isOk(resp: { status?: string }): boolean {
  return resp?.status === "success";
}
