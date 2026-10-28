/**
 * 内置 qqbot_send_file 工具 — 将本地文件发送给 QQ 用户或群。
 *
 *   - Zeta 接入要求显式目标，使用目录返回的 target；
 *     单独使用上游适配器时仍支持原有当前会话定位。
 *   - 按扩展名分发到 SDK 的 sendImage / sendVideo / sendVoice / sendFile。
 *   - 路径白名单：默认只允许访问 media 目录 + agent cwd，可开关 + 扩展白名单。
 */
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ImQQBotConfig } from '../config.ts';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { isPathAllowed, sendMediaFile, type MediaSenderLike } from './send-media.ts';
import type { ZetaRuntime } from '../zeta/runtime.ts';

/** 工具名（qqbot 前缀避免与其他通道的同名工具冲突） */
export const SEND_FILE_TOOL_NAME = 'qqbot_send_file';

const DESCRIPTION =
  'Send a local file (image, video, voice, or generic file) to the QQ user or group '
  + 'of the current conversation. Pass the absolute path of a file that already exists on disk. '
  + 'Use this when the user asks you to deliver a generated file (chart, report, exported data, '
  + 'screenshot, etc.) or to send an existing media/file back to them.';

/** 发送器与分类发送的共享实现见 send-media.ts（扩展名分发 + 白名单为单一事实源） */
export type { MediaSenderLike, MediaSendResult } from './send-media.ts';

/** tools 服务最小接口 */
interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

/** qqbot_send_file 的合法参数 */
interface SendFileArgs {
  file_path: string;
  target?: string;
}

/** 解析显式 target（"c2c:openid" / "group:openid"），非法返回 undefined */
function parseTarget(input: string): ReplyTarget | undefined {
  const idx = input.indexOf(':');
  if (idx <= 0) return undefined;
  const scope = input.slice(0, idx);
  const targetId = input.slice(idx + 1);
  if (!targetId || (scope !== 'c2c' && scope !== 'group')) return undefined;
  return { scope, targetId };
}

/** 注册 qqbot_send_file 工具（tools 服务缺失时优雅降级，不阻断插件启动） */
export function registerSendFileTool(
  ctx: Context,
  bot: MediaSenderLike,
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
  zeta?: ZetaRuntime,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_send_file 工具未注册');
    return;
  }

  const cwd = config.cwd || process.cwd();

  const definition = {
    name: SEND_FILE_TOOL_NAME,
    description: zeta ? 'Send an existing local image, video, voice or file to the explicit QQ target returned by zeta_conversation_list. Always provide file_path and target; a request to send to a group must name that group target, never the requesting private chat. After a successful receipt, do not send the same file again. Use zeta_speech_send to deliver saved speech without regeneration.' : DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the local file to send (image/video/voice/generic file).',
        },
        target: {
          type: 'string',
          description: zeta ? 'Required actual destination as "c2c:openid" or "group:openid", from zeta_conversation_list. Never omit or guess the target.' : 'Optional send target as "c2c:openid" or "group:openid". Omit to send to the current conversation.',
        },
      },
      required: zeta ? ['file_path', 'target'] : ['file_path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          fileName: { type: 'string' },
          fileSize: { type: 'integer' },
          target: { type: 'string' },
          fileUuid: { type: 'string' },
          messageId: { type: 'string' },
        },
        required: ['fileName', 'fileSize', 'target', 'fileUuid'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { fileName: string; target: string };
        return [{ type: 'text', text: `已发送 ${v.fileName} → ${v.target}` }];
      },
    },
    async execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown>> {
      const { file_path, target } = args as SendFileArgs;
      if (typeof file_path !== 'string' || file_path.length === 0) {
        throw new Error('qqbot_send_file: `file_path` must be a non-empty string');
      }
      if (zeta) {
        const result = await zeta.sendFile(exec.agent, resolve(file_path), target, exec.signal);
        return { fileName: result.fileName, fileSize: result.size, target: result.target, fileUuid: result.fileUuid ?? '', ...(result.messageId ? { messageId: result.messageId } : {}) };
      }

      // 1. 解析发送目标：显式 target > 当前会话（exec.agent → SessionRecord）
      let replyTarget: ReplyTarget | undefined;
      if (target !== undefined && target !== '') {
        replyTarget = parseTarget(target);
        if (replyTarget === undefined) {
          throw new Error(`qqbot_send_file: target 格式错误，需要 c2c:openid 或 group:openid，收到: ${target}`);
        }
      } else if (exec.agent !== undefined) {
        replyTarget = manager.findByAgent(exec.agent as DshAgent)?.replyTarget;
      }
      if (replyTarget === undefined) {
        throw new Error('qqbot_send_file: 无法确定发送目标，请显式传 target 参数');
      }

      // 2. 校验文件 + 路径白名单
      const absPath = resolve(file_path);
      if (!isPathAllowed(absPath, config.sendFile, cwd)) {
        throw new Error(`qqbot_send_file: file_path 不在允许的目录内: ${absPath}`);
      }
      if (!existsSync(absPath)) {
        throw new Error(`qqbot_send_file: 文件不存在: ${absPath}`);
      }

      // 3. 按扩展名分类发送（与交付物投递共用 send-media 的分发实现）
      const fileName = basename(absPath);
      const result = await sendMediaFile(bot, replyTarget, absPath);
      if (result.outcome === 'missing') {
        throw new Error(`qqbot_send_file: 文件不存在或不可读: ${absPath}`);
      }
      if (result.outcome === 'failed') {
        throw new Error(`qqbot_send_file: 发送失败: ${result.error}`);
      }

      logger.info(`im-qqbot: qqbot_send_file 发送 ${fileName} (${result.size} bytes) → ${replyTarget.scope}:${replyTarget.targetId}`);

      return {
        fileName,
        fileSize: result.size,
        target: `${replyTarget.scope}:${replyTarget.targetId}`,
        fileUuid: result.fileUuid ?? '',
        ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
      };
    },
  };

  tools.register(definition);
  logger.info('im-qqbot: qqbot_send_file 工具已注册');
}
