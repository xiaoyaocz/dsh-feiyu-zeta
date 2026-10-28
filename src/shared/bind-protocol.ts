/**
 * 端内绑定协议 —— 宿主路由与客户端面板的共享契约
 *
 * 类型与路径常量的唯一事实源：宿主（setup/bind-routes.ts）与浏览器
 * （client/bind-page.ts）各自 import，杜绝两端协议漂移。
 * 本模块必须保持纯类型 + 纯常量（零 node 依赖、零副作用）：
 * 客户端 tsdown 构建会将其内联进 bundle。
 */

import { QQBOT_API_PATH } from './http-paths.ts';

/** 状态查询（绑定页轮询） */
export const BIND_STATE_PATH = `${QQBOT_API_PATH}/bind`;

/** 刷新二维码（绑定页按钮） */
export const BIND_REFRESH_PATH = `${QQBOT_API_PATH}/bind/refresh`;

/** 手动填写/编辑凭据（绑定页表单） */
export const BIND_MANUAL_PATH = `${QQBOT_API_PATH}/bind/manual`;

/** 解绑：移除已保存凭据，回到绑定流程 */
export const BIND_UNBIND_PATH = `${QQBOT_API_PATH}/bind/unbind`;

/** 配置读写（设置面板表单） */
export const BIND_CONFIG_PATH = `${QQBOT_API_PATH}/config`;

/** 线上协议（HTTP 路由序列化形态） */
export type BindStateWire =
  | { phase: 'starting' }
  | { phase: 'waiting'; url: string; qrSvg?: string; issuedAt: number }
  | { phase: 'saving' }
  | { phase: 'failed'; reason: string }
  | { phase: 'bound'; appId: string };

/** manual / unbind 操作的统一响应 */
export interface BindActionResponse {
  ok: boolean;
  message?: string;
  error?: string;
}
