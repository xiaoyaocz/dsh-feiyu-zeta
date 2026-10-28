/**
 * 交付物投递 — present 声明的文件在轮末发送到当前 QQ 会话
 *
 * 宿主契约：`deliverables/presented` 事件先于 turn/end 到达；文件按引用交付
 * （不复制内容），读取发生在投递时刻；外层轮次失败不撤销已完成的声明。
 * 每个文件独立投递，失败降级为文字提示，不阻断其余文件。
 */
import { basename, isAbsolute, resolve } from 'node:path';
import { isPathAllowed, sendMediaFile } from "../media/send-media.js";
import { chunkMarkdownText } from "./chunker.js";
export class DeliverablesDeliverer {
    zeta;
    sender;
    mediaBot;
    config;
    logger;
    constructor(sender, mediaBot, config, logger, zeta) {
        this.zeta = zeta;
        this.sender = sender;
        this.mediaBot = mediaBot;
        this.config = config;
        this.logger = logger;
    }
    /** 轮末投递一批声明文件：逐个发送，未送达的聚合为一条文字提示 */
    async deliver(record, files) {
        const limit = Math.max(1, this.config.sendFile?.maxFiles ?? 4);
        const cwd = this.config.cwd || process.cwd();
        const missed = [];
        let sent = 0;
        for (const [index, file] of files.entries()) {
            // 新声明记录绝对路径；历史相对路径按插件工作目录兜底解析
            const absPath = isAbsolute(file.path) ? file.path : resolve(cwd, file.path);
            const display = basename(absPath);
            if (index >= limit) {
                missed.push(`${display}（超出单轮投递上限，未发送）`);
                continue;
            }
            if (!isPathAllowed(absPath, this.config.sendFile, cwd)) {
                missed.push(`${display}（路径不在允许范围）`);
                continue;
            }
            const result = this.zeta
                ? await this.zeta.sendFile(record.agent, absPath, undefined, new AbortController().signal)
                    .then(value => ({ outcome: 'sent', size: Number(value.size) }))
                    .catch(() => ({ outcome: 'failed', error: '未收到平台确认，或文件不在当前会话允许范围' }))
                : await sendMediaFile(this.mediaBot, record.replyTarget, absPath);
            if (result.outcome === 'sent') {
                sent++;
                this.logger.info(`im-qqbot: 交付物已发送 ${display} (${result.size} bytes) → `
                    + `${record.replyTarget.scope}:${record.replyTarget.targetId}`);
            }
            else if (result.outcome === 'failed') {
                this.logger.warn(`im-qqbot: 交付物发送失败 ${display}: ${result.error}`);
                missed.push(display);
            }
            else {
                missed.push(display);
            }
        }
        if (missed.length > 0) {
            const text = ['📎 已生成文件（未能直接发送）：', ...missed.map((name) => `- ${name}`)].join('\n');
            for (const chunk of chunkMarkdownText(text, this.config.textChunkLimit)) {
                try {
                    await this.sender.sendMarkdown(record.replyTarget, chunk);
                }
                catch (err) {
                    this.logger.error(`im-qqbot: deliverables notice failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        this.logger.debug(`im-qqbot: deliverables delivered sent=${sent} missed=${missed.length}`);
    }
}
//# sourceMappingURL=deliverables.js.map