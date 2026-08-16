// 事件日志：按天 JSONL 文件（events-YYYY-MM-DD.jsonl），每行一个结构化事件。
// 用途：问题定位（拦截/解析/配置/错误时间线）与统计分析（模型调用、token、
// 费用、缓存命中、耗时）。目录可配置（默认 userData/logs），保留 N 天自动清理。
//
// 事件规范（area 用短横线小写，type 用短横线小写）：
//   user-action   —— sidecar 上报的用户操作（图片粘贴拦截等）
//   ipc           —— 主进程 IPC 调用（saveVisionImage/setVisionSettings 等）
//   vision-analyze—— 视觉解析请求结果（后端/模型/token/耗时/缓存/成功失败）
//   tool-call     —— 工具调用（vision_understand）
//   session       —— 会话请求快照（reportBillingUsage 落盘）
//   setting-change—— 设置变更前后值
//   error         —— 异常（message + 堆栈摘要）
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

export interface EventLogEntry {
  ts: string;
  seq: number;
  area: string;
  type: string;
  [key: string]: unknown;
}

export interface EventLogOptions {
  /** 返回当前日志目录（动态读取，支持运行时切换） */
  directory: () => string;
  /** 保留天数，默认 30 */
  retentionDays?: number;
}

export interface RecentError {
  ts: string;
  type: string;
  message: string;
}

export class EventLog {
  private readonly directory: () => string;
  private readonly retentionDays: number;
  private seq = 0;
  /** 内存中的最近错误（append error 时顺带记录，供状态徽标/分析实时读取，零文件 IO）。 */
  private recentErrors: RecentError[] = [];

  constructor(options: EventLogOptions) {
    this.directory = options.directory;
    this.retentionDays = options.retentionDays ?? 30;
  }

  /** 最近 withinMs 毫秒内的错误事件（按时间倒序）。 */
  getRecentErrors(withinMs: number): RecentError[] {
    const cutoff = Date.now() - withinMs;
    return this.recentErrors.filter(
      (entry) => Date.parse(entry.ts) >= cutoff,
    );
  }

  private dayStamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /** 追加一条事件；写入失败不抛出（日志不能拖垮业务）。 */
  async append(
    area: string,
    type: string,
    fields: Record<string, unknown> = {},
  ): Promise<void> {
    const now = new Date();
    const entry: EventLogEntry = {
      ts: now.toISOString(),
      seq: ++this.seq,
      area,
      type,
      ...fields,
    };
    try {
      const directory = this.directory();
      const file = path.join(directory, `events-${this.dayStamp(now)}.jsonl`);
      await mkdir(directory, { recursive: true });
      await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // 日志失败不影响业务
    }
    if (area === "error") {
      this.recentErrors.push({
        ts: entry.ts,
        type,
        message:
          typeof fields.message === "string"
            ? fields.message.slice(0, 400)
            : String(fields.message ?? type),
      });
      if (this.recentErrors.length > 50) this.recentErrors.shift();
    }
  }

  /** 清理超过保留天数的日志文件（按文件名 events-*.jsonl 的日期判断）。 */
  async prune(): Promise<number> {
    let removed = 0;
    try {
      const directory = this.directory();
      const cutoff = this.dayStamp(new Date(Date.now() - this.retentionDays * 86_400_000));
      const entries = await readdir(directory);
      for (const entry of entries) {
        const match = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry);
        if (!match) continue;
        if (match[1]! < cutoff) {
          const file = path.join(directory, entry);
          await rm(file, { force: true });
          removed += 1;
        }
      }
    } catch {
      // 目录不存在等错误忽略
    }
    return removed;
  }

  /** 当前日志目录（用于 UI 展示 / 打开文件夹）。 */
  directoryPath(): string {
    return this.directory();
  }
}
