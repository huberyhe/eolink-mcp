/**
 * Eolink MCP server 共享常量。
 * 凭证不硬编码、不进仓库；支持命令行参数与环境变量两种来源。
 */

/** 当前版本号，server 注册与启动日志共用，避免两处漂移 */
export const VERSION = "1.2.0";

/**
 * 命令行参数 → 配置项映射。
 * 命名取环境变量的小写连字符形式，便于记忆：
 *   --base-url ↔ EOLINK_BASE_URL
 *   --token    ↔ EOLINK_TOKEN
 *   --space-id ↔ EOLINK_SPACE_ID
 */
const CLI_VALUE_FLAGS = {
  "--base-url": "baseUrl",
  "--token": "token",
  "--space-id": "spaceId",
} as const;

/** 布尔型开关（出现即为真） */
const CLI_BOOL_FLAGS = {
  "--no-proxy": "noProxy",
  "--verify-on-start": "verifyOnStart",
  "-h": "help",
  "--help": "help",
} as const;

type CliConfig = {
  baseUrl?: string;
  token?: string;
  spaceId?: string;
  noProxy?: boolean;
  verifyOnStart?: boolean;
  help?: boolean;
};

export const USAGE = `用法: eolink-mcp [选项]

配置项（命令行参数优先于环境变量）:
  --base-url <url>     Eolink 实例 Open API 根地址   (env: EOLINK_BASE_URL)
  --token <token>      Open API 令牌               (env: EOLINK_TOKEN)
  --space-id <id>      工作空间 ID                  (env: EOLINK_SPACE_ID)
  --no-proxy           禁用代理解析                  (env: EOLINK_NO_PROXY=1)
  --verify-on-start    启动时联网校验凭据有效性       (env: EOLINK_VERIFY_ON_START=1)
  -h, --help           显示本帮助

写法：--key value 与 --key=value 都支持。值本身以 - 开头时必须用 = 形式
（如 --token=-abc）；开关类参数不接受值，关闭请直接去掉该参数。
project_id 不在此配置，用 eolink_list_projects 选取后传给各工具。`;

/**
 * 解析命令行参数。
 *
 * 之所以在模块顶层就解析：配置常量是模块级 const，必须在它们求值前拿到结果。
 * process.argv 在模块初始化时已可用，故无需把常量改成惰性求值。
 */
function parseCliArgs(argv: string[]): {
  opts: CliConfig;
  unknown: string[];
  warnings: string[];
} {
  const opts: CliConfig = {};
  const unknown: string[] = [];
  const warnings: string[] = [];

  // 用 hasOwnProperty 而非 `in`：`in` 会命中 Object.prototype 上的属性，
  // 使 `--constructor`、`--toString` 这类参数被误判为已识别。
  const hasOwn = (obj: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(obj, key);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // 拆出 --key=value 形式
    const eq = arg.indexOf("=");
    const key = eq > 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq > 0 ? arg.slice(eq + 1) : undefined;

    if (hasOwn(CLI_BOOL_FLAGS, key)) {
      // 布尔开关不接受值。若不拦，`--no-proxy=false` 会被当成「出现了即开启」，
      // 与直觉相反（用户想关掉反而打开），故对 false/0/no 显式报错。
      if (inlineValue !== undefined && /^(false|0|no)$/i.test(inlineValue.trim())) {
        warnings.push(
          `${key}=${inlineValue} 无效：${key} 是开关，不接受值。` +
            `关闭它请直接去掉该参数${envHintFor(key)}。`
        );
        continue;
      }
      opts[CLI_BOOL_FLAGS[key as keyof typeof CLI_BOOL_FLAGS]] = true;
      continue;
    }
    if (hasOwn(CLI_VALUE_FLAGS, key)) {
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[i + 1];
        // 下一个是另一个 flag 或已到末尾时，视为未提供值（不吞掉后续 flag）。
        // 代价：值本身以 `-` 开头时必须改用 --key=value 形式，见 USAGE 说明。
        if (next !== undefined && !next.startsWith("-")) {
          value = next;
          i++;
        }
      }
      const trimmed = (value ?? "").trim();
      if (trimmed) {
        opts[CLI_VALUE_FLAGS[key as keyof typeof CLI_VALUE_FLAGS]] = trimmed;
      } else if (inlineValue !== undefined || value !== undefined) {
        // 空值不覆盖环境变量（避免 `--token ""` 把已配好的配置清空），
        // 但要说一声——静默回落会让人以为参数生效了。
        warnings.push(`${key} 收到空值，已回落到环境变量${envHintFor(key)}。`);
      }
      continue;
    }
    // 只记录参数名，丢掉 `=` 后的值：用户可能把 token 拼错成 `--tokens=<真实令牌>`，
    // 若原样打印就把凭证写进了日志/stderr。
    if (arg.startsWith("-")) unknown.push(key);
    // 不以 `-` 开头的裸词（位置参数）无法归类，也提示出来
    else warnings.push(`忽略无法识别的参数: ${arg}`);
  }
  return { opts, unknown, warnings };
}

/** 给出某个参数对应的环境变量名，用于提示文案 */
function envHintFor(key: string): string {
  const map: Record<string, string> = {
    "--base-url": "EOLINK_BASE_URL",
    "--token": "EOLINK_TOKEN",
    "--space-id": "EOLINK_SPACE_ID",
    "--no-proxy": "EOLINK_NO_PROXY=1",
    "--verify-on-start": "EOLINK_VERIFY_ON_START=1",
  };
  const env = map[key];
  return env ? `（对应环境变量 ${env}）` : "";
}

const { opts: CLI, unknown: UNKNOWN_ARGS, warnings: CLI_WARNINGS } =
  parseCliArgs(process.argv.slice(2));

if (CLI.help) {
  // stdio 下 stdout 被协议占用，帮助信息必须走 stderr
  console.error(USAGE);
  process.exit(0);
}
// 一律不退出：客户端可能在 args 里塞入自身参数，硬失败会误伤；
// 但都要提示出来，避免拼写错误被静默当成「未配置」。
if (UNKNOWN_ARGS.length > 0) {
  console.error(
    `WARN: eolink-mcp 忽略无法识别的参数: ${UNKNOWN_ARGS.join(" ")}\n${USAGE}`
  );
}
for (const w of CLI_WARNINGS) console.error(`WARN: eolink-mcp ${w}`);

/** 配置项来源，供 eolink_health_check 展示 */
export type ConfigSource = "命令行参数" | "环境变量" | "未设置";

function pick(cliValue: string | undefined, envName: string): { value: string; source: ConfigSource } {
  if (cliValue) return { value: cliValue, source: "命令行参数" };
  const fromEnv = (process.env[envName] ?? "").trim();
  if (fromEnv) return { value: fromEnv, source: "环境变量" };
  return { value: "", source: "未设置" };
}

const baseUrlCfg = pick(CLI.baseUrl, "EOLINK_BASE_URL");
const tokenCfg = pick(CLI.token, "EOLINK_TOKEN");
const spaceIdCfg = pick(CLI.spaceId, "EOLINK_SPACE_ID");

/**
 * Eolink 实例的 Open API 基础地址（不含末尾斜杠）。
 * 无默认值——必须由使用者传入（--base-url 或 EOLINK_BASE_URL），
 * 这样包不绑定任何特定部署/内网，对 SaaS 和私有化都通用。
 *
 * 这里 trim 并去掉尾随斜杠：配置里手抄 URL 常带空格或末尾 `/`，
 * 会导致拼接出 `//v2/...` 这类畸形路径而被网关拒绝。
 */
export const API_BASE_URL = normalizeBaseUrl(baseUrlCfg.value);

/**
 * Open API 鉴权令牌（请求头 Eo-Secret-Key）。
 * trim 掉首尾空白：从后台复制令牌时极易带上换行/空格，
 * 而网关对格式错误一律回 200007，表现为「token 明明填了却说格式错」。
 */
export const EO_SECRET_KEY = tokenCfg.value;

/** 工作空间 ID（space_id）。同样 trim，理由同上。 */
export const SPACE_ID = spaceIdCfg.value;

/** 各项配置的来源，供自检工具展示（便于排查「到底哪个来源生效」） */
export const CONFIG_SOURCES: Record<string, ConfigSource> = {
  EOLINK_BASE_URL: baseUrlCfg.source,
  EOLINK_TOKEN: tokenCfg.source,
  EOLINK_SPACE_ID: spaceIdCfg.source,
};

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
 * 需要时用 --verify-on-start 或 EOLINK_VERIFY_ON_START=1 开启。
 */
export const VERIFY_ON_START = CLI.verifyOnStart === true || process.env.EOLINK_VERIFY_ON_START === "1";

/** 启动探测的超时（毫秒）。取较短值，避免拖慢启动 */
export const VERIFY_TIMEOUT = 5000;

/** 单次返回的字符上限，防止响应撑爆 LLM 上下文 */
export const CHARACTER_LIMIT = 25000;

/** 请求超时（毫秒） */
export const REQUEST_TIMEOUT = 30000;

/**
 * 代理配置：Node 的 axios 默认不读系统 HTTP(S)_PROXY 环境变量，
 * 而访问 Eolink 实例（尤其私有化内网部署）常需经代理（curl 会自动走，axios 不会）。
 * 这里把常见代理 env 透传给 axios。用 --no-proxy 或 EOLINK_NO_PROXY=1 可禁用。
 */
export function resolveProxy(): { host: string; port: number } | undefined {
  if (CLI.noProxy === true || process.env.EOLINK_NO_PROXY === "1") return undefined;
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
 * 校验必需配置已注入（project_id 由工具参数动态传入，不在此校验）。
 *
 * 保持 fail-fast：配置缺失时直接退出，避免带着坏配置去发请求。
 * 错误信息首行自包含关键结论——stdio 客户端通常只回显 stderr 首行或摘要；
 * 缺失项会连带打印 USAGE，便于就地看到全部可用参数。
 *
 * 注意这里只校验「本地可判定」的问题（缺失、URL 非法）；
 * token / space_id 的真实有效性必须联网才能确认，交给 eolink_health_check。
 */
export function assertConfig(): void {
  const missing: string[] = [];
  if (!API_BASE_URL) missing.push("--base-url / EOLINK_BASE_URL");
  if (!EO_SECRET_KEY) missing.push("--token / EOLINK_TOKEN");
  if (!SPACE_ID) missing.push("--space-id / EOLINK_SPACE_ID");
  if (missing.length > 0) {
    console.error(
      `ERROR: eolink-mcp 缺少必需配置: ${missing.join(", ")}。` +
        `请用命令行参数或 MCP 客户端配置的 env 补齐（参数优先）。` +
        `--base-url（实例 Open API 根地址，如 https://your-eolink.example.com）、` +
        `--token（开放 API 令牌，即请求头 Eo-Secret-Key）、` +
        `--space-id（工作空间 ID）。\n${USAGE}`
    );
    process.exit(1);
  }
  if (!isValidBaseUrl(API_BASE_URL)) {
    console.error(
      `ERROR: eolink-mcp 的 base url 不是合法地址` +
        `（来源：${CONFIG_SOURCES.EOLINK_BASE_URL}）。` +
        `应为带协议的 Open API 根地址，如 https://your-eolink.example.com（不要末尾斜杠）。` +
        `当前值前 20 字符：${API_BASE_URL.slice(0, 20)}`
    );
    process.exit(1);
  }
  // token 形态告警（非阻断）：太短基本可断定没填完整
  if (EO_SECRET_KEY.length < 16) {
    console.error(
      `WARN: eolink-mcp 的 token 仅 ${EO_SECRET_KEY.length} 字符，疑似未填完整` +
        `（来源：${CONFIG_SOURCES.EOLINK_TOKEN}）。` +
        `请在 Eolink 后台『空间设置 / 开放 API』重新生成；填错时网关会返回 code 200007。`
    );
  }
}
