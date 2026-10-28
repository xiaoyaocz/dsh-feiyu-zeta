window.__ModuleLoader__.load({
	id: "dsh-feiyu-zeta",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		// src/shared/http-paths.ts
		/** Public plugin routes live beneath the carrier's plugin namespace. */
		const PLUGIN_HTTP_PREFIX = "/plugins/dsh-feiyu-zeta";
		const ZETA_API_PATH = `${PLUGIN_HTTP_PREFIX}/api`;
		const QQBOT_API_PATH = `${PLUGIN_HTTP_PREFIX}/qqbot`;
		// src/shared/bind-protocol.ts
		/**
		* 端内绑定协议 —— 宿主路由与客户端面板的共享契约
		*
		* 类型与路径常量的唯一事实源：宿主（setup/bind-routes.ts）与浏览器
		* （client/bind-page.ts）各自 import，杜绝两端协议漂移。
		* 本模块必须保持纯类型 + 纯常量（零 node 依赖、零副作用）：
		* 客户端 tsdown 构建会将其内联进 bundle。
		*/
		/** 状态查询（绑定页轮询） */
		const BIND_STATE_PATH = `${QQBOT_API_PATH}/bind`;
		/** 刷新二维码（绑定页按钮） */
		const BIND_REFRESH_PATH = `${QQBOT_API_PATH}/bind/refresh`;
		/** 手动填写/编辑凭据（绑定页表单） */
		const BIND_MANUAL_PATH = `${QQBOT_API_PATH}/bind/manual`;
		/** 解绑：移除已保存凭据，回到绑定流程 */
		const BIND_UNBIND_PATH = `${QQBOT_API_PATH}/bind/unbind`;
		/** 配置读写（设置面板表单） */
		const BIND_CONFIG_PATH = `${QQBOT_API_PATH}/config`;
		// src/client/bind-page.ts
		/**
		* 端内绑定面板 — 扫码 / 手动填写 / 已绑定编辑
		*
		* 宿主插件注册 /qqbot/im-qqbot/bind 路由（待绑定与已绑定 fiber 均常驻）：
		* - 未绑定：waiting（二维码）/ starting / saving / failed 相位 + manual 提交
		* - 已绑定：bound 相位（回显脱敏 appId，secret 不回传）+ manual 更换 + 解绑
		* 扫码成功或手动保存均写入 profile patch 并经 HMR 重载生效。
		*
		* 样式为注入式 CSS 类（imqb-* 命名空间，随面板挂载注入一次）：
		* hover/过渡/focus 样式无法用 inline style 表达，统一走类；
		* 颜色尽量取 DSW 主题变量（--dsw-alias-*），缺省值兜底。
		*
		* 同一组件复用于两种展示位（侧栏绑定页 / 设置页 QQ Bot 栏目）。
		* 运行时仅依赖 react（dsh 客户端平台种子表提供）；宿主通信走同源 fetch，
		* Desktop 下由壳的 IPC 桥自动附加 Host 认证转发。
		*/
		/** 轮询间隔（毫秒）：活跃轮询 / 失败退避 */
		const ACTIVE_POLL_MS = 2e3;
		const RETRY_POLL_MS = 3e3;
		/** 样式注入标记（幂等） */
		const STYLE_ID$1 = "im-qqbot-bind-panel-styles";
		/**
		* 注入面板样式（全局一次，幂等）。交互态（hover/active/focus）无法用 inline
		* style 表达，统一收敛到类；DSW 主题变量缺失时用中性值兜底。
		* 插件激活时即安装：插件详情按钮渲染在面板之外，需提前可见；
		* 安装后不再随挂载移除，避免多个展示位互相清掉样式。
		*/
		function installPanelStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID$1) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID$1;
			style.textContent = `
.imqb-panel {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; padding: 24px; min-height: 320px; text-align: center; font-size: 14px;
}
.imqb-title { margin: 0; font-size: 16px; font-weight: 600; }
.imqb-hint { margin: 0; opacity: 0.75; line-height: 1.6; }
.imqb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.imqb-link { font-size: 13px; opacity: 0.85; color: var(--dsw-alias-brand, #4d6bfe); text-decoration: none; }
.imqb-link:hover { text-decoration: underline; }
.imqb-icon { font-size: 32px; line-height: 1; }
.imqb-qr { border-radius: 10px; background: #fff; padding: 10px; max-width: 100%; }
.imqb-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.imqb-btn, .imqb-pill {
  font: inherit; cursor: pointer; color: inherit;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease;
}
.imqb-btn:disabled, .imqb-pill:disabled { opacity: 0.5; cursor: default; }
.imqb-btn {
  padding: 7px 18px; border-radius: 8px; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4));
  background: transparent;
}
.imqb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.imqb-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-brand, #4d6bfe); color: #fff; font-weight: 500;
}
.imqb-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-brand-strong, #3b5cf0); }
.imqb-btn--danger { color: var(--dsw-alias-danger, #f26d6d); border-color: var(--dsw-alias-danger, rgba(242, 109, 109, 0.5)); }
.imqb-btn--danger:hover:not(:disabled) { background: var(--dsw-alias-danger, rgba(242, 109, 109, 0.12)); }
.imqb-ghost {
  border: none; background: transparent; opacity: 0.65; padding: 4px 8px;
  font: inherit; font-size: 13px; cursor: pointer; color: inherit;
}
.imqb-ghost:hover { opacity: 1; text-decoration: underline; }
/* 插件详情「设置」按钮：30px，略高于旁边的 sm 次要按钮 */
.imqb-pluginOpen {
  display: inline-flex; align-items: center; justify-content: center;
  box-sizing: border-box; height: 30px; padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4));
  border-radius: 8px; background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit); font: inherit;
  font-size: 13px; line-height: 20px; cursor: pointer;
}
.imqb-pluginOpen:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.imqb-pluginOpen:focus-visible { outline: 2px solid var(--dsw-alias-brand, #4d6bfe); outline-offset: 3px; }
@media (pointer: coarse) { .imqb-pluginOpen { height: 44px; } }
/* 主面板页面容器（layout.selectPanel 目标）：滚动 + 留白 */
.imqb-pluginPage {
  height: 100%; min-height: 0; overflow: auto; box-sizing: border-box;
  padding: 24px clamp(16px, 4vw, 48px) 32px;
  color: var(--dsw-alias-label-primary, #1f2329);
}
.imqb-pluginPageContent { max-width: 1080px; margin: 0 auto; }
.imqb-pill {
  padding: 5px 16px; border-radius: 999px; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4)); background: transparent;
}
.imqb-pill:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.imqb-btn:focus-visible, .imqb-pill:focus-visible, .imqb-input:focus-visible, .imqb-ghost:focus-visible {
  outline: 2px solid var(--dsw-alias-brand, #4d6bfe); outline-offset: 1px;
}
.imqb-form { display: flex; flex-direction: column; gap: 12px; width: min(320px, 100%); box-sizing: border-box; }
.imqb-field { display: flex; flex-direction: column; gap: 5px; text-align: left; font-size: 13px; }
.imqb-input {
  padding: 8px 10px; border-radius: 8px; box-sizing: border-box; width: 100%;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4));
  background: var(--dsw-alias-bg-input, rgba(128, 128, 128, 0.08));
  color: inherit; font: inherit; font-size: 13px; outline: none;
}
.imqb-input:focus { border-color: var(--dsw-alias-brand, #4d6bfe); }
.imqb-error { margin: 0; font-size: 12px; color: var(--dsw-alias-danger, #f26d6d); }
/* 紧凑状态视图（已绑定 / 过渡态）：设置行风格，无居中大卡留白 */
.imqb-status { display: flex; flex-direction: column; text-align: left; font-size: 14px; }
.imqb-status-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
.imqb-status-icon { font-size: 24px; line-height: 1; flex: none; }
.imqb-qqicon {
  flex: none; display: block; border-radius: 8px; /* 透明底，QQ 蓝徽标在明暗主题下均清晰 */
}
.imqb-status-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.imqb-status-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; }
.imqb-status-sub { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, inherit); opacity: .85; }
.imqb-status-actions { display: flex; align-items: center; gap: 8px; padding: 4px 0 12px; }
/* 扫码成功后的连接过渡：二维码模糊变暗 + 覆盖层 */
.imqb-scanned { position: relative; display: inline-block; }
.imqb-scanned-qr {
  display: block; border-radius: 10px; background: #fff; padding: 10px;
  filter: blur(6px) saturate(0.6); opacity: 0.55;
}
.imqb-scanned-veil {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px; text-align: center;
}
.imqb-scanned-title { margin: 0; font-size: 15px; font-weight: 600; }
.imqb-scanned-sub { margin: 0; font-size: 12px; opacity: 0.75; line-height: 1.6; }
    `;
			document.head.appendChild(style);
		}
		function usePanelStyles() {
			(0, react.useEffect)(() => {
				installPanelStyles();
			}, []);
		}
		/**
		* 绑定状态轮询 hook。
		*
		* 404 语义分两种：从未拿到过路由 = 插件未启用（终态）；
		* 曾经拿到过 = HMR 重载窗口期（manual/unbind 保存后路由短暂消失），
		* 低频等待恢复而不是判定终态——否则保存成功提示会被
		* 「插件未启用」覆盖且无法自愈。
		*
		* bound 为稳定态：轮询大幅降频（30s）。因此解绑等本地动作后必须
		* 调用 recheck() 立即重置节拍——否则视图最长停留 30s+ 才收敛到
		* 新相位（如解绑后的 waiting 二维码）。
		*
		* @returns 轮询快照与 recheck：state 为宿主相位（null = 加载中），
		*          gone 表示插件未启用（从未注册过路由），recheck 废弃当前
		*          定时器并立即重新轮询（新轮询链取代旧链，不产生双计时器）。
		*/
		function useBindState() {
			const [state, setState] = (0, react.useState)(null);
			const [gone, setGone] = (0, react.useState)(false);
			const recheckRef = (0, react.useRef)(() => {});
			(0, react.useEffect)(() => {
				let stopped = false;
				let sawRoute = false;
				let generation = 0;
				let running = false;
				let restartAfterFlight = false;
				let urgentUntil = 0;
				let timer;
				const schedule = (ms) => {
					timer = setTimeout(() => {
						tick();
					}, ms);
				};
				const intervalFor = (phase) => {
					const base = phase === "saving" ? 500 : phase === "bound" ? 3e4 : ACTIVE_POLL_MS;
					return Date.now() < urgentUntil ? Math.min(base, ACTIVE_POLL_MS) : base;
				};
				const tick = async () => {
					if (stopped || running) return;
					running = true;
					const myGeneration = generation;
					const alive = () => myGeneration === generation && !stopped;
					try {
						const res = await fetch(BIND_STATE_PATH, { cache: "no-store" });
						if (res.status === 404) {
							if (!stopped && !sawRoute) setGone(true);
							else if (alive()) schedule(Date.now() < urgentUntil ? 1e3 : 3e3);
							return;
						}
						if (!res.ok) {
							if (alive()) schedule(RETRY_POLL_MS);
							return;
						}
						sawRoute = true;
						const body = await res.json();
						if (!alive()) return;
						setState(body);
						schedule(intervalFor(body.phase));
						return;
					} catch {} finally {
						running = false;
						if (restartAfterFlight && !stopped) {
							restartAfterFlight = false;
							tick();
						}
					}
					if (alive()) schedule(RETRY_POLL_MS);
				};
				recheckRef.current = () => {
					generation += 1;
					urgentUntil = Date.now() + 15e3;
					if (timer !== void 0) clearTimeout(timer);
					if (running) {
						restartAfterFlight = true;
						return;
					}
					tick();
				};
				tick();
				return () => {
					stopped = true;
					if (timer !== void 0) clearTimeout(timer);
				};
			}, []);
			return {
				state,
				gone,
				recheck: (0, react.useCallback)(() => {
					recheckRef.current();
				}, [])
			};
		}
		/** 手动提交凭据（填写 / 更换共用） */
		async function submitManualCredentials(appId, appSecret) {
			try {
				const res = await fetch(BIND_MANUAL_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						appId,
						appSecret
					})
				});
				const body = await res.json().catch(() => ({}));
				if (res.ok && body.ok) return {
					ok: true,
					message: body.message
				};
				return {
					ok: false,
					error: body.error ?? `保存失败（HTTP ${res.status}）`
				};
			} catch (err) {
				return {
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}
		/**
		* 手动凭据表单（填写 / 更换共用）。
		*
		* appSecret 永不回显（占位符提示），提交成功后展示保存结果；
		* 宿主写入 profile patch 并经 HMR 重载，状态轮询随后收敛为 bound。
		*/
		function ManualForm({ initialAppId }) {
			const [appId, setAppId] = (0, react.useState)(initialAppId ?? "");
			const [appSecret, setAppSecret] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [result, setResult] = (0, react.useState)(null);
			const submit = (0, react.useCallback)((event) => {
				event.preventDefault();
				if (busy) return;
				const trimmedId = appId.trim();
				const trimmedSecret = appSecret.trim();
				if (trimmedId.length === 0 || trimmedSecret.length === 0) {
					setResult({
						ok: false,
						error: "appId 与 appSecret 均为必填"
					});
					return;
				}
				setBusy(true);
				submitManualCredentials(trimmedId, trimmedSecret).then((outcome) => {
					setResult(outcome);
					setBusy(false);
				});
			}, [
				appId,
				appSecret,
				busy
			]);
			if (result !== null && result.ok) return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)("div", { className: "imqb-status-icon" }, "✅"), (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, result.message ?? "凭据已保存"), (0, react.createElement)("p", { className: "imqb-status-sub" }, "插件将自动重载；稍后即可开始对话"))));
			return (0, react.createElement)("form", {
				className: "imqb-form",
				onSubmit: submit
			}, (0, react.createElement)("label", { className: "imqb-field" }, "AppID", (0, react.createElement)("input", {
				className: "imqb-input",
				value: appId,
				placeholder: "QQ 机器人 AppID",
				onChange: (event) => {
					setAppId(event.currentTarget.value);
				},
				autoComplete: "off",
				spellCheck: false
			})), (0, react.createElement)("label", { className: "imqb-field" }, "AppSecret", (0, react.createElement)("input", {
				className: "imqb-input",
				type: "password",
				value: appSecret,
				placeholder: initialAppId === void 0 ? "QQ 机器人 AppSecret" : "输入新的 AppSecret（不回显）",
				onChange: (event) => {
					setAppSecret(event.currentTarget.value);
				},
				autoComplete: "new-password"
			})), result !== null && !result.ok ? (0, react.createElement)("p", { className: "imqb-error" }, result.error) : null, (0, react.createElement)("button", {
				className: "imqb-btn imqb-btn--primary",
				type: "submit",
				disabled: busy
			}, busy ? "正在保存…" : "保存"));
		}
		/** QQ 机器人 logo 路径（assets/icons/qqbot_logo.svg，内嵌以保持 bundle 自包含） */
		const QQ_BOT_LOGO_PATH = "M19.3862 15.5001C19.3861 11.4203 16.0789 8.11296 11.999 8.11292C7.91915 8.11292 4.61203 11.4203 4.61182 15.5001V17.0001C4.61182 18.5949 5.90429 19.8873 7.49902 19.8873H16.499C18.0937 19.8873 19.3862 18.5949 19.3862 17.0001V15.5001ZM10.6118 14.0001C10.6118 14.6145 10.1129 15.1134 9.49853 15.1134C8.8843 15.1132 8.38672 14.6144 8.38672 14.0001V12.0006C8.38672 11.3863 8.8843 10.8875 9.49853 10.8873C10.1129 10.8873 10.6118 11.3862 10.6118 12.0006V14.0001ZM15.6113 14.0001C15.6113 14.6143 15.1136 15.1131 14.4995 15.1134C13.8851 15.1134 13.3862 14.6145 13.3862 14.0001V12.0006C13.3862 11.3862 13.8851 10.8873 14.4995 10.8873C15.1136 10.8876 15.6113 11.3864 15.6113 12.0006V14.0001ZM14.2607 3.04895C14.2607 3.89351 13.7957 4.62474 13.1108 5.0133V5.95374C17.8958 6.50514 21.6112 10.5676 21.6113 15.5001V17.0001C21.6113 19.8237 19.3225 22.1124 16.499 22.1124H7.49902C4.67546 22.1124 2.38672 19.8237 2.38672 17.0001V15.5001C2.38691 10.568 6.10139 6.50571 10.8857 5.95374V5.01185C10.2017 4.62305 9.73583 3.89286 9.73583 3.04895C9.73609 1.79961 10.7496 0.787231 11.999 0.787231C13.2484 0.787297 14.2605 1.79966 14.2607 3.04895Z";
		/** QQ 机器人图标（logo 矢量渲染，透明底，随 size 缩放） */
		function QqBotIcon({ size = 28 }) {
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": true,
				className: "imqb-qqicon"
			}, (0, react.createElement)("path", {
				d: QQ_BOT_LOGO_PATH,
				fill: "#0085FF"
			}));
		}
		/** 已绑定视图：回显 appId + 更换凭据 / 解绑入口 */
		function BoundView({ appId, recheck }) {
			const [editing, setEditing] = (0, react.useState)(false);
			const [unbindResult, setUnbindResult] = (0, react.useState)(null);
			const unbind = (0, react.useCallback)(() => {
				if (!window.confirm("确定解绑吗？\n解绑后机器人立即下线，插件将重新进入扫码绑定流程。")) return;
				fetch(BIND_UNBIND_PATH, { method: "POST" }).then(async (res) => {
					const body = await res.json().catch(() => ({}));
					if (res.ok && body.ok === true) {
						setUnbindResult({
							ok: true,
							message: body.message ?? "已解绑，插件将重载并重新进入绑定流程"
						});
						recheck();
						return;
					}
					setUnbindResult({
						ok: false,
						message: body.error ?? `解绑失败（HTTP ${res.status}）`
					});
				}).catch((err) => {
					setUnbindResult({
						ok: false,
						message: err instanceof Error ? err.message : String(err)
					});
				});
			}, [recheck]);
			if (unbindResult !== null) return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)("div", { className: "imqb-status-icon" }, unbindResult.ok ? "👋" : "⚠️"), (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, unbindResult.message)), unbindResult.ok ? (0, react.createElement)("button", {
				className: "imqb-ghost",
				onClick: recheck
			}, "刷新状态") : (0, react.createElement)("button", {
				className: "imqb-ghost",
				onClick: () => {
					setUnbindResult(null);
				}
			}, "返回")));
			if (editing) return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, "更换凭据")), (0, react.createElement)("button", {
				className: "imqb-ghost",
				onClick: () => {
					setEditing(false);
				}
			}, "返回")), (0, react.createElement)(ManualForm, { initialAppId: appId }));
			return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)(QqBotIcon, { size: 28 }), (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, "已绑定"), (0, react.createElement)("p", { className: "imqb-status-sub imqb-mono" }, `AppID ${appId} · 私聊与群聊已接入`))), (0, react.createElement)("div", { className: "imqb-status-actions" }, (0, react.createElement)("button", {
				className: "imqb-btn imqb-btn--primary",
				onClick: () => {
					setEditing(true);
				}
			}, "更换凭据"), (0, react.createElement)("button", {
				className: "imqb-btn imqb-btn--danger",
				onClick: unbind
			}, "解绑")));
		}
		/** 未绑定视图：扫码 / 手动填写切换 */
		function UnboundView({ state }) {
			const [mode, setMode] = (0, react.useState)("qr");
			const refresh = (0, react.useCallback)(() => {
				fetch(BIND_REFRESH_PATH, { method: "POST" }).catch(() => {});
			}, []);
			if (mode === "manual") return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("p", { className: "imqb-title" }, "手动填写凭据"), (0, react.createElement)(ManualForm, {}), (0, react.createElement)("button", {
				className: "imqb-ghost",
				onClick: () => {
					setMode("qr");
				}
			}, "改用扫码绑定"));
			return (0, react.createElement)("div", { className: "imqb-panel" }, state.qrSvg === void 0 ? null : (0, react.createElement)("img", {
				src: state.qrSvg,
				alt: "QQ 扫码二维码",
				width: 220,
				height: 220,
				className: "imqb-qr"
			}), (0, react.createElement)("p", { className: "imqb-title" }, "扫码绑定 QQ 机器人"), (0, react.createElement)("p", { className: "imqb-hint" }, "使用手机 QQ 扫描二维码完成绑定"), (0, react.createElement)("a", {
				href: state.url,
				target: "_blank",
				rel: "noreferrer noopener",
				className: "imqb-link"
			}, "二维码显示异常？在浏览器中打开"), (0, react.createElement)("div", { className: "imqb-row" }, (0, react.createElement)("button", {
				className: "imqb-pill",
				onClick: refresh
			}, "刷新二维码"), (0, react.createElement)("button", {
				className: "imqb-pill",
				onClick: () => {
					setMode("manual");
				}
			}, "手动填写")));
		}
		/** 依据宿主相位渲染面板主体（各展示位共用） */
		function BindPanelBody() {
			usePanelStyles();
			const { state, gone, recheck } = useBindState();
			const [lastQr, setLastQr] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				if (state === null) return;
				if (state.phase === "waiting") {
					if (state.qrSvg !== void 0) setLastQr(state.qrSvg);
				} else if (state.phase === "bound") setLastQr(null);
			}, [state]);
			if (gone) return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("div", { className: "imqb-icon" }, "❔"), (0, react.createElement)("p", { className: "imqb-hint" }, "插件未启用，或当前版本不支持端内配置"));
			if (state === null || state.phase === "starting") return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("p", { className: "imqb-hint" }, "正在获取绑定状态…"));
			if (state.phase === "saving") {
				if (lastQr !== null) return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("div", { className: "imqb-scanned" }, (0, react.createElement)("img", {
					src: lastQr,
					alt: "QQ 扫码二维码",
					width: 220,
					height: 220,
					className: "imqb-scanned-qr"
				}), (0, react.createElement)("div", { className: "imqb-scanned-veil" }, (0, react.createElement)("p", { className: "imqb-scanned-title" }, "✅ 扫码成功"), (0, react.createElement)("p", { className: "imqb-scanned-sub" }, "正在连接机器人，稍候…"))));
				return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)("div", { className: "imqb-status-icon" }, "🎉"), (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, "扫码成功"), (0, react.createElement)("p", { className: "imqb-status-sub" }, "凭据已保存，插件正在重载，稍后即可开始对话"))));
			}
			if (state.phase === "failed") return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("div", { className: "imqb-icon" }, "⚠️"), (0, react.createElement)("p", { className: "imqb-title" }, "绑定失败"), (0, react.createElement)("p", { className: "imqb-hint" }, state.reason), (0, react.createElement)("div", { className: "imqb-row" }, (0, react.createElement)("button", {
				className: "imqb-btn imqb-btn--primary",
				onClick: () => {
					window.location.reload();
				}
			}, "重试")));
			if (state.phase === "bound") return (0, react.createElement)(BoundView, {
				appId: state.appId,
				recheck
			});
			return (0, react.createElement)(UnboundView, { state });
		}
		// src/client/config-panel.ts
		/**
		* dsh-feiyu-zeta QQ 接入配置面板 — 必要配置的 UI 编辑
		*
		* UI 复刻 DSW 通用设置（settings-form 原语）的视觉风格：
		* 左对齐设置列、0.5px 行分隔、label 13px/500、控件右置；
		* Switch 为 36×20 aria-checked 结构（thumb translateX 动画）；
		* 三值选择用分段控件（滑动指示器按段数/索引的 CSS 变量定位）；
		* 保存按钮为 DSW 反色主按钮（label-primary 底 + bg-layer-3 字）。
		*
		* 数据流：GET BIND_CONFIG_PATH 回显当前生效配置（appSecret
		* 已由宿主剔除）→ 表单编辑 → dirty diff → POST 仅提交变更键 →
		* 宿主白名单 + Schema 校验 → 最小写入 profile patch → HMR 重载生效。
		*
		* 字段策略：只开放用户必要的配置；cwd 只读展示；超时与性能调优
		* 类字段走 profile patch / 环境变量。
		*/
		/** 样式注入标记（幂等） */
		const STYLE_ID = "im-qqbot-config-panel-styles";
		/** DSW 通用设置风格（settings-form / Switch / SegmentedControl 原语复刻） */
		function useConfigPanelStyles() {
			(0, react.useEffect)(() => {
				if (typeof document === "undefined") return;
				if (document.getElementById(STYLE_ID) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = `
.imqb2-form { display: flex; flex-direction: column; width: 100%; }
.imqb2-group-title {
  padding: 14px 0 2px; font-size: 12px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: .04em;
}
.imqb2-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.imqb2-field + .imqb2-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.imqb2-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.imqb2-label {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.imqb2-help { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.imqb2-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
/* Switch（aria-checked 驱动，视觉态与无障碍态同源） */
.imqb2-switch {
  box-sizing: border-box; position: relative; flex: 0 0 auto;
  width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l3); cursor: pointer; font: inherit;
}
.imqb2-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.imqb2-switch:disabled { cursor: default; opacity: 0.5; }
.imqb2-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.imqb2-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #ffffff);
  transition: transform 120ms ease;
}
.imqb2-switch[aria-checked='true'] .imqb2-switch-thumb {
  background: var(--dsw-alias-label-primary-foreground, #ffffff);
  transform: translateX(16px);
}
/* 输入（官方 fields.input 复刻） */
.imqb2-input {
  box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary); outline: none;
}
.imqb2-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.imqb2-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.imqb2-textarea { height: auto; min-height: 68px; padding: 8px 12px; resize: vertical; line-height: 1.5; }
/* 分段控件（官方 SegmentedControl 复刻：指示器按段数/索引定位） */
.imqb2-seg {
  position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: 2px; padding: 4px; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover);
}
.imqb2-seg-indicator {
  position: absolute; top: 4px; left: 4px;
  width: calc((100% - 8px - 2px * (var(--imqb2-seg-count) - 1)) / var(--imqb2-seg-count));
  height: calc(100% - 8px);
  border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-soft, 0 1px 3px rgba(0,0,0,.08));
  transform: translateX(calc(var(--imqb2-seg-index) * (100% + 2px)));
  transition: transform 160ms ease;
  pointer-events: none;
}
.imqb2-seg-tab {
  box-sizing: border-box; position: relative; z-index: 1; height: 28px; padding: 0 16px;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px;
  font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 120ms ease;
}
.imqb2-seg-tab:hover, .imqb2-seg-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); }
.imqb2-seg-tab:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
/* 底栏（官方 SettingsForm.footer 复刻） */
.imqb2-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.imqb2-note { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.imqb2-note--error { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error)); }
.imqb2-note--ok { color: var(--dsw-alias-label-secondary); }
.imqb2-save {
  appearance: none; flex: none; border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px); padding: 5px 14px;
  font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3);
}
.imqb2-save:disabled { opacity: 0.4; cursor: default; }
.imqb2-save:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
/* cwd 只读行 */
.imqb2-readonly { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; margin: 0; }
    `;
				document.head.appendChild(style);
				return () => {
					style.remove();
				};
			}, []);
		}
		/** 开关（官方 Switch 原语结构：aria-checked 驱动视觉态） */
		function Switch({ checked, label, onChange }) {
			return (0, react.createElement)("button", {
				type: "button",
				role: "switch",
				"aria-checked": checked,
				"aria-label": label,
				className: "imqb2-switch",
				onClick: () => {
					onChange(!checked);
				}
			}, (0, react.createElement)("span", { className: "imqb2-switch-thumb" }));
		}
		/** 访问模式分段选择（官方 SegmentedControl 结构：CSS 变量定位滑动指示器） */
		function Segmented({ value, options, onChange, label }) {
			const index = Math.max(0, options.findIndex((o) => o.value === value));
			const trackStyle = {
				"--imqb2-seg-count": options.length,
				"--imqb2-seg-index": index
			};
			return (0, react.createElement)("div", {
				className: "imqb2-seg",
				role: "tablist",
				"aria-label": label,
				style: trackStyle
			}, (0, react.createElement)("span", { className: "imqb2-seg-indicator" }), options.map((o) => (0, react.createElement)("button", {
				key: o.value,
				type: "button",
				role: "tab",
				"aria-selected": o.value === value,
				className: "imqb2-seg-tab",
				onClick: () => {
					onChange(o.value);
				}
			}, o.label)));
		}
		/** 开关行（label 左 + Switch 右 + 可选 help） */
		function SwitchRow({ label, help, checked, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("div", { className: "imqb2-head" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)(Switch, {
				checked,
				label,
				onChange
			})), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-help" }, help));
		}
		/** 文本行（label 上 + 输入下，与官方 fields 布局一致） */
		function FieldRow({ label, help, value, placeholder, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)("input", {
				className: "imqb2-input",
				value,
				placeholder,
				spellCheck: false,
				onChange: (event) => {
					onChange(event.currentTarget.value);
				}
			}), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-hint" }, help));
		}
		/** 多行文本行 */
		function AreaRow({ label, help, value, rows, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)("textarea", {
				className: "imqb2-input imqb2-textarea",
				value,
				rows: rows ?? 3,
				onChange: (event) => {
					onChange(event.currentTarget.value);
				}
			}), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-hint" }, help));
		}
		/** 访问模式分段选择行 */
		function SegmentedRow({ label, help, value, options, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("div", { className: "imqb2-head" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)(Segmented, {
				value,
				options,
				onChange,
				label
			})), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-hint" }, help));
		}
		const MODE_OPTIONS = [
			{
				value: "open",
				label: "所有人"
			},
			{
				value: "allowlist",
				label: "白名单"
			},
			{
				value: "disabled",
				label: "禁用"
			}
		];
		/** 深比较（表单值与初始回显值的 dirty 判断） */
		function shallowEqual(a, b) {
			return JSON.stringify(a) === JSON.stringify(b);
		}
		/**
		* 配置面板主体。
		*
		* 保存仅提交变更键（服务端按白名单合并），保存成功后提示
		* HMR 重载语义（进行中的机器人会话将重置）。
		*/
		function ConfigPanel() {
			useConfigPanelStyles();
			const [initial, setInitial] = (0, react.useState)(null);
			const [form, setForm] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [result, setResult] = (0, react.useState)(null);
			const [loadError, setLoadError] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let stopped = false;
				fetch(BIND_CONFIG_PATH, { cache: "no-store" }).then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const body = await res.json();
					if (stopped) return;
					setInitial(body.config);
					setForm(body.config);
				}).catch((err) => {
					if (!stopped) setLoadError(err instanceof Error ? err.message : String(err));
				});
				return () => {
					stopped = true;
				};
			}, []);
			const patch = (0, react.useCallback)((key, value) => {
				setForm((current) => current === null ? current : {
					...current,
					[key]: value
				});
				setResult(null);
			}, []);
			const submit = (0, react.useCallback)((event) => {
				event.preventDefault();
				if (busy || initial === null || form === null) return;
				const changed = {};
				for (const key of Object.keys(form)) if (!shallowEqual(form[key], initial[key])) changed[key] = form[key];
				if (Object.keys(changed).length === 0) return;
				if (changed.access !== void 0) {
					const a = changed.access;
					changed.access = {
						...a,
						c2cAllow: a.c2cAllow.map((s) => s.trim()).filter(Boolean),
						groupAllow: a.groupAllow.map((s) => s.trim()).filter(Boolean)
					};
				}
				setBusy(true);
				fetch(BIND_CONFIG_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(changed)
				}).then(async (res) => {
					const body = await res.json().catch(() => ({}));
					if (res.ok && body.ok === true) {
						setResult({
							ok: true,
							message: body.message ?? "配置已保存，插件将自动重载"
						});
						setInitial(form);
						return;
					}
					setResult({
						ok: false,
						message: body.error ?? `保存失败（HTTP ${res.status}）`
					});
				}).catch((err) => {
					setResult({
						ok: false,
						message: err instanceof Error ? err.message : String(err)
					});
				}).finally(() => {
					setBusy(false);
				});
			}, [
				busy,
				form,
				initial
			]);
			if (loadError !== null) return (0, react.createElement)("p", {
				className: "imqb2-hint",
				style: { padding: "12px 0" }
			}, `配置加载失败：${loadError}`);
			if (initial === null || form === null) return (0, react.createElement)("p", {
				className: "imqb2-hint",
				style: { padding: "12px 0" }
			}, "正在加载配置…");
			const dirty = Object.keys(form).some((key) => !shallowEqual(form[key], initial[key]));
			const access = form.access ?? {
				c2cMode: "open",
				c2cAllow: [],
				groupMode: "open",
				groupAllow: []
			};
			return (0, react.createElement)("form", {
				className: "imqb2-form",
				onSubmit: submit,
				"aria-label": "dsh-feiyu-zeta QQ 接入配置"
			}, (0, react.createElement)("div", { className: "imqb2-group-title" }, "服务范围"), (0, react.createElement)(SegmentedRow, {
				label: "私聊",
				value: access.c2cMode,
				options: MODE_OPTIONS,
				onChange: (v) => {
					patch("access", {
						...access,
						c2cMode: v
					});
				}
			}), access.c2cMode === "allowlist" ? (0, react.createElement)(AreaRow, {
				label: "私聊白名单",
				help: "请输入用户 openid，多个请换行输入",
				rows: 3,
				value: access.c2cAllow.join("\n"),
				onChange: (v) => {
					patch("access", {
						...access,
						c2cAllow: v.split("\n").map((s) => s.trim())
					});
				}
			}) : null, (0, react.createElement)(SegmentedRow, {
				label: "群聊",
				value: access.groupMode,
				options: MODE_OPTIONS,
				onChange: (v) => {
					patch("access", {
						...access,
						groupMode: v
					});
				}
			}), access.groupMode === "allowlist" ? (0, react.createElement)(AreaRow, {
				label: "群聊白名单",
				help: "请输入群 openid，多个请换行输入",
				rows: 3,
				value: access.groupAllow.join("\n"),
				onChange: (v) => {
					patch("access", {
						...access,
						groupAllow: v.split("\n").map((s) => s.trim())
					});
				}
			}) : null, (0, react.createElement)("div", { className: "imqb2-group-title" }, "基础设置"), (0, react.createElement)(SwitchRow, {
				label: "群聊仅回复 @机器人的消息",
				checked: form.requireMention ?? true,
				help: "开启后，机器人仅可回复 @机器人的群聊消息",
				onChange: (v) => {
					patch("requireMention", v);
				}
			}), (0, react.createElement)(SwitchRow, {
				label: "流式输出",
				checked: form.streaming ?? true,
				help: "回复内容分段实时推送到聊天",
				onChange: (v) => {
					patch("streaming", v);
				}
			}), (0, react.createElement)(SwitchRow, {
				label: "显示工具调用结果",
				checked: form.showToolResults ?? false,
				help: "在聊天中展示 agent 工具调用的结构化结果",
				onChange: (v) => {
					patch("showToolResults", v);
				}
			}), (0, react.createElement)("div", { className: "imqb2-group-title" }, "模型"), (0, react.createElement)(FieldRow, {
				label: "Provider",
				value: form.provider ?? "",
				placeholder: "留空继承宿主默认",
				onChange: (v) => {
					patch("provider", v);
				}
			}), (0, react.createElement)(FieldRow, {
				label: "Model",
				value: form.model ?? "",
				placeholder: "留空继承宿主默认",
				onChange: (v) => {
					patch("model", v);
				}
			}), (0, react.createElement)(FieldRow, {
				label: "Preset",
				value: form.preset ?? "",
				placeholder: "Agent preset id",
				onChange: (v) => {
					patch("preset", v);
				}
			}), (0, react.createElement)("div", { className: "imqb2-group-title" }, "个性化提示词"), (0, react.createElement)(AreaRow, {
				label: "群聊额外 system prompt",
				value: form.groupPrompt ?? "",
				onChange: (v) => {
					patch("groupPrompt", v);
				}
			}), (0, react.createElement)(AreaRow, {
				label: "私聊额外 system prompt",
				value: form.directPrompt ?? "",
				onChange: (v) => {
					patch("directPrompt", v);
				}
			}), form.cwd !== void 0 ? (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("div", { className: "imqb2-head" }, (0, react.createElement)("span", { className: "imqb2-label" }, "Agent 工作目录"), (0, react.createElement)("span", { className: "imqb2-hint" }, "只读")), (0, react.createElement)("p", { className: "imqb2-readonly" }, form.cwd)) : null, (0, react.createElement)("div", { className: "imqb2-footer" }, result !== null ? (0, react.createElement)("p", { className: `imqb2-note${result.ok ? " imqb2-note--ok" : " imqb2-note--error"}` }, (result.ok ? "" : "⚠️ ") + result.message) : dirty ? (0, react.createElement)("p", { className: "imqb2-note" }, "保存后插件将重载，进行中的机器人会话将重置") : (0, react.createElement)("p", { className: "imqb2-note" }), (0, react.createElement)("button", {
				className: "imqb2-save",
				type: "submit",
				disabled: busy || !dirty
			}, busy ? "正在保存…" : "保存")));
		}
		// src/shared/settings-patch.ts
		/** Deep partial settings merge. Arrays replace; neither input is mutated. */
		function mergeSettingsPatch(current, patch, depth = 0) {
			if (depth > 12) throw new Error("设置修改层级过深");
			if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
			const entries = Object.entries(patch);
			if (entries.some(([key]) => [
				"__proto__",
				"prototype",
				"constructor"
			].includes(key))) throw new Error("设置字段无效");
			const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
			return Object.fromEntries([...Object.entries(base).filter(([key]) => !Object.hasOwn(patch, key)), ...entries.map(([key, value]) => [key, mergeSettingsPatch(base[key], value, depth + 1)])]);
		}
		// src/client/settings-draft.ts
		function record(value) {
			return !!value && typeof value === "object" && !Array.isArray(value);
		}
		/** Only locally edited leaves are sent; arrays remain indivisible settings. */
		function settingsChanges(baseline, draft) {
			const before = record(baseline) ? baseline : {};
			const after = record(draft) ? draft : {};
			return Object.fromEntries(Object.entries(after).flatMap(([key, value]) => {
				if (JSON.stringify(before[key]) === JSON.stringify(value)) return [];
				if (record(before[key]) && record(value)) {
					const nested = settingsChanges(before[key], value);
					return Object.keys(nested).length ? [[key, nested]] : [];
				}
				return [[key, structuredClone(value)]];
			}));
		}
		/** Refresh remote values while retaining actual local edits, not stale fields. */
		function rebaseSettingsDraft(baseline, draft, latest) {
			return mergeSettingsPatch(structuredClone(latest), settingsChanges(baseline, draft));
		}
		// src/client/zeta-panel.ts
		const API = ZETA_API_PATH;
		const PLUGIN_NAME = "dsh-feiyu-zeta";
		const TABS = [
			{
				id: "overview",
				label: "概览"
			},
			{
				id: "persona",
				label: "人设"
			},
			{
				id: "conversations",
				label: "会话"
			},
			{
				id: "memory",
				label: "记忆"
			},
			{
				id: "memes",
				label: "表情"
			},
			{
				id: "speech",
				label: "语音"
			},
			{
				id: "life",
				label: "自主生活"
			},
			{
				id: "security",
				label: "管理员与群聊"
			},
			{
				id: "services",
				label: "外部服务"
			},
			{
				id: "backup",
				label: "备份迁移"
			}
		];
		const PROVIDER_NAME = {
			mimo: "MiMo",
			minimax: "MiniMax"
		};
		const EMOTIONS = [
			{
				value: "auto",
				label: "自动"
			},
			{
				value: "happy",
				label: "开心"
			},
			{
				value: "sad",
				label: "难过"
			},
			{
				value: "angry",
				label: "生气"
			},
			{
				value: "fearful",
				label: "害怕"
			},
			{
				value: "disgusted",
				label: "嫌弃"
			},
			{
				value: "surprised",
				label: "惊讶"
			},
			{
				value: "calm",
				label: "平静"
			}
		];
		async function responseError(response) {
			let message = "操作未完成，请检查连接后重试。";
			try {
				const value = await response.json();
				if (value && typeof value === "object" && "error" in value && typeof value.error === "string") message = value.error.slice(0, 2e3);
			} catch {}
			return new Error(message);
		}
		async function request(path, method = "GET", body, signal, headers) {
			let response;
			try {
				response = await fetch(`${API}${path}`, {
					method,
					credentials: "same-origin",
					cache: "no-store",
					signal,
					headers: {
						...body === void 0 ? {} : { "content-type": "application/json" },
						...headers
					},
					...body === void 0 ? {} : { body: JSON.stringify(body) }
				});
			} catch (error) {
				if (signal?.aborted) throw error;
				throw new Error(`暂时无法连接 ${PLUGIN_NAME}，请稍后刷新。`);
			}
			if (!response.ok) throw await responseError(response);
			if (response.status === 204) return void 0;
			try {
				return await response.json();
			} catch {
				throw new Error("服务返回的数据无法读取，请刷新后重试。");
			}
		}
		function message(error) {
			return error instanceof Error ? error.message : "操作未完成，请稍后重试。";
		}
		function date(value) {
			if (!value) return "尚无记录";
			const parsed = new Date(value);
			return Number.isNaN(parsed.getTime()) ? "时间未知" : parsed.toLocaleString("zh-CN", { hour12: false });
		}
		function keywords(value) {
			return Array.isArray(value) ? value.join("，") : value ?? "";
		}
		function splitTags(value) {
			return [...new Set(value.split(/[\s,，]+/u).map((part) => part.trim()).filter(Boolean))];
		}
		function targetLines(value) {
			return [...new Set(value.split(/\r?\n/u).map((part) => part.trim()).filter(Boolean))];
		}
		function conversationName(value) {
			return value.alias || value.title || `${value.scope === "group" ? "群聊" : "私聊"} ${value.peerId}`;
		}
		function knownConversations(state) {
			const values = /* @__PURE__ */ new Map();
			for (const binding of state.conversations === void 0 ? state.bindings : []) {
				const target = `${binding.scope}:${binding.peerId}`;
				values.set(target, {
					...binding,
					target,
					lastSeenAt: 0,
					active: true
				});
			}
			for (const conversation of state.conversations ?? []) values.set(conversation.target, conversation);
			return [...values.values()].sort((a, b) => Number(b.active) - Number(a.active) || b.lastSeenAt - a.lastSeenAt || conversationName(a).localeCompare(conversationName(b), "zh-CN"));
		}
		function mediaPath(kind, id) {
			return `${API}/media?${new URLSearchParams({
				kind,
				id
			})}`;
		}
		function useTask(feedback) {
			const [busy, setBusy] = (0, react.useState)(false);
			const pending = (0, react.useRef)(false);
			return {
				busy,
				run: (0, react.useCallback)(async (work) => {
					if (pending.current) return;
					pending.current = true;
					setBusy(true);
					try {
						await work();
					} catch (error) {
						feedback(message(error), true);
					} finally {
						pending.current = false;
						setBusy(false);
					}
				}, [feedback])
			};
		}
		function useStyles() {
			(0, react.useEffect)(() => {
				if (typeof document === "undefined" || document.getElementById("zeta-settings-style")) return;
				const style = document.createElement("style");
				style.id = "zeta-settings-style";
				style.textContent = `
.zeta-settings{color:var(--dsw-alias-label-primary,#20242c);font:13px/1.6 system-ui,sans-serif;max-width:960px;width:100%;min-width:0;margin:22px auto 0;padding-top:18px;border-top:1px solid var(--dsw-alias-border-l2,#ddd);box-sizing:border-box}
.zeta-settings *{box-sizing:border-box}.zeta-settings h2,.zeta-settings h3,.zeta-settings p{margin:0}.zeta-settings h2{font-size:20px;letter-spacing:-.4px}.zeta-settings h3{font-size:14px;font-weight:600}
.zeta-settings button,.zeta-settings input,.zeta-settings textarea,.zeta-settings select{font:inherit;color:inherit}.zeta-settings button{cursor:pointer}.zeta-settings button:disabled{cursor:default;opacity:.5}
.zeta-settings input,.zeta-settings select,.zeta-settings textarea{max-width:100%;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l4,#d8dbe1);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);padding:8px 10px;outline:none}
.zeta-settings textarea{resize:vertical;line-height:1.65;min-height:94px}.zeta-settings input:focus,.zeta-settings textarea:focus,.zeta-settings select:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.zeta-settings button:focus-visible,.zeta-settings a:focus-visible,.zeta-settings summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:3px}.zeta-settings input[type=checkbox]{width:16px;height:16px;flex:0 0 16px;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.zeta-settings fieldset{border:0;margin:0;padding:0;min-width:0}.zeta-settings .zs-head,.zeta-settings .zs-row,.zeta-settings .zs-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.zeta-settings .zs-head{justify-content:space-between;margin-bottom:16px}
.zeta-settings .zs-stack{display:flex;flex-direction:column;gap:16px;min-width:0}.zeta-settings .zs-muted{color:var(--dsw-alias-label-secondary,#697280);font-size:12px;overflow-wrap:anywhere}.zeta-settings .zs-small{font-size:11px}
.zeta-settings .zs-tabs{display:flex;gap:4px;overflow-x:auto;padding:4px;margin-bottom:18px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,#f2f3f6)}
.zeta-settings .zs-tab{flex:1 0 auto;border:0;border-radius:7px;padding:8px 12px;background:transparent;color:var(--dsw-alias-label-secondary,#6a717d);white-space:nowrap}.zeta-settings .zs-tab[aria-selected=true]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#20242c);box-shadow:0 1px 4px #0000000a}
.zeta-settings .zs-button{border:1px solid var(--dsw-alias-border-l4,#d7dbe2);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);padding:7px 12px;white-space:normal;overflow-wrap:anywhere}.zeta-settings .zs-primary{background:var(--dsw-alias-label-primary,#20242c);color:var(--dsw-alias-bg-layer-3,#fff);border-color:transparent}.zeta-settings .zs-danger{color:var(--dsw-alias-state-error-primary,#bd3131)}
.zeta-settings .zs-card{border:1px solid var(--dsw-alias-border-l2,#e2e5eb);border-radius:12px;padding:16px;min-width:0;background:var(--dsw-alias-bg-layer-2,transparent)}
.zeta-settings .zs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.zeta-settings .zs-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}.zeta-settings .zs-stat{font-size:20px;font-weight:600;margin-top:6px;overflow-wrap:anywhere}
.zeta-settings .zs-field{display:flex;flex-direction:column;gap:6px;min-width:0}.zeta-settings .zs-label{font-weight:500}.zeta-settings .zs-check{display:flex;align-items:flex-start;gap:9px;cursor:pointer;min-width:0}.zeta-settings .zs-check input{margin-top:3px}.zeta-settings .zs-check span{min-width:0;overflow-wrap:anywhere}.zeta-settings .zs-check small{display:block;color:var(--dsw-alias-label-secondary,#697280);font-size:12px;font-weight:400;margin-top:2px}
.zeta-settings .zs-notice{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,#f2f4f7);margin-bottom:14px;overflow-wrap:anywhere}.zeta-settings .zs-error{color:var(--dsw-alias-state-error-primary,#bd3131);border:1px solid currentColor}
.zeta-settings .zs-empty{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-secondary,#697280)}.zeta-settings .zs-body{white-space:pre-wrap;overflow-wrap:anywhere}.zeta-settings .zs-record{padding:13px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#e3e6eb)}.zeta-settings .zs-record:last-child{border-bottom:0}.zeta-settings .zs-record-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:6px}.zeta-settings .zs-record-title{font-weight:600;overflow-wrap:anywhere;min-width:0}.zeta-settings .zs-badge{display:inline-block;padding:2px 7px;border-radius:99px;font-size:11px;background:var(--dsw-alias-interactive-bg-hover,#eef1f6);font-weight:400}
.zeta-settings .zs-search{display:flex;align-items:center;gap:8px}.zeta-settings .zs-search input{flex:1}.zeta-settings .zs-memes{display:grid;grid-template-columns:repeat(auto-fill,minmax(125px,1fr));gap:12px}.zeta-settings .zs-meme{display:flex;flex-direction:column;gap:8px;text-align:left;border:1px solid var(--dsw-alias-border-l2,#e0e4eb);border-radius:10px;padding:8px;background:var(--dsw-alias-bg-layer-3,#fff);min-width:0}.zeta-settings .zs-meme[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}.zeta-settings .zs-picture{width:100%;aspect-ratio:1;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,#f5f6f8)}.zeta-settings .zs-picture img{display:block;max-width:100%;max-height:100%;object-fit:contain}.zeta-settings .zs-caption{font-size:12px;overflow-wrap:anywhere}.zeta-settings .zs-preview{max-width:280px;width:100%;margin:auto}.zeta-settings audio{width:100%;max-width:100%}.zeta-settings .zs-loading{padding:24px;text-align:center}.zeta-settings details>summary{cursor:pointer;font-weight:500}.zeta-settings details[open]>summary{margin-bottom:12px}.zeta-settings .zs-spacer{flex:1}.zeta-settings .zs-code{font-family:ui-monospace,monospace;font-size:11px;overflow-wrap:anywhere}.zeta-settings .zs-targets{max-height:250px;overflow:auto;display:flex;flex-direction:column;gap:9px}
@media(max-width:600px){.zeta-settings .zs-grid{grid-template-columns:1fr}.zeta-settings .zs-card{padding:12px}.zeta-settings .zs-memes{grid-template-columns:repeat(2,minmax(0,1fr))}.zeta-settings .zs-record-head{flex-wrap:wrap}.zeta-settings .zs-actions>*{max-width:100%}.zeta-settings .zs-head{align-items:flex-start}.zeta-settings .zs-search{align-items:stretch;flex-wrap:wrap}.zeta-settings .zs-search input{min-width:140px}.zeta-settings .zs-tab{padding:8px 10px}.zeta-settings .zs-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
				document.head.appendChild(style);
			}, []);
		}
		function Button({ children, onClick, disabled, primary, danger, type = "button" }) {
			return (0, react.createElement)("button", {
				type,
				disabled,
				onClick,
				className: `zs-button${primary ? " zs-primary" : ""}${danger ? " zs-danger" : ""}`
			}, children);
		}
		function Field({ label, hint, children }) {
			return (0, react.createElement)("label", { className: "zs-field" }, (0, react.createElement)("span", { className: "zs-label" }, label), children, hint ? (0, react.createElement)("span", { className: "zs-muted" }, hint) : null);
		}
		function Check({ label, hint, checked, onChange, disabled }) {
			return (0, react.createElement)("label", { className: "zs-check" }, (0, react.createElement)("input", {
				type: "checkbox",
				checked,
				disabled,
				onChange: (event) => onChange(event.target.checked)
			}), (0, react.createElement)("span", null, label, hint ? (0, react.createElement)("small", null, hint) : null));
		}
		function NumberField({ label, hint, value, min, max, step = 1, onChange }) {
			return (0, react.createElement)(Field, {
				label,
				hint,
				children: (0, react.createElement)("input", {
					type: "number",
					value,
					min,
					max,
					step,
					required: true,
					onChange: (event) => onChange(Number(event.target.value))
				})
			});
		}
		function Empty({ children }) {
			return (0, react.createElement)("div", { className: "zs-empty" }, children);
		}
		async function readBase64(file, maxBytes) {
			if (file.size === 0 || file.size > maxBytes) throw new Error(`请选择不超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB 的非空文件。`);
			return await new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onerror = () => reject(/* @__PURE__ */ new Error("无法读取所选文件。"));
				reader.onload = () => {
					if (typeof reader.result !== "string" || !reader.result.includes(",")) reject(/* @__PURE__ */ new Error("无法读取所选文件。"));
					else resolve(reader.result.slice(reader.result.indexOf(",") + 1));
				};
				reader.readAsDataURL(file);
			});
		}
		function useMedia(url) {
			const [state, setState] = (0, react.useState)({ failed: false });
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				let objectUrl;
				setState({ failed: false });
				if (url) (async () => {
					try {
						const response = await fetch(url, {
							credentials: "same-origin",
							cache: "no-store",
							signal: controller.signal
						});
						if (!response.ok) throw await responseError(response);
						const blob = await response.blob();
						if (controller.signal.aborted) return;
						objectUrl = URL.createObjectURL(blob);
						setState({
							objectUrl,
							failed: false
						});
					} catch {
						if (!controller.signal.aborted) setState({ failed: true });
					}
				})();
				return () => {
					controller.abort();
					if (objectUrl) URL.revokeObjectURL(objectUrl);
				};
			}, [url]);
			return state;
		}
		function MediaImage({ item }) {
			const media = useMedia(mediaPath("meme", item.id));
			return (0, react.createElement)("span", { className: "zs-picture" }, media.objectUrl ? (0, react.createElement)("img", {
				src: media.objectUrl,
				alt: item.caption || "表情图片"
			}) : (0, react.createElement)("span", { className: "zs-muted" }, media.failed ? "预览暂不可用" : "加载图片…"));
		}
		function AudioPreview({ item }) {
			const media = useMedia(mediaPath("speech", item.fileName));
			return (0, react.createElement)("div", { className: "zs-stack" }, media.objectUrl ? (0, react.createElement)("audio", {
				controls: true,
				preload: "metadata",
				src: media.objectUrl,
				"aria-label": `${PROVIDER_NAME[item.provider]}语音试听`
			}) : (0, react.createElement)("p", { className: "zs-muted" }, media.failed ? "音频暂时无法读取，请刷新后重试。" : "正在读取音频…"), item.notice ? (0, react.createElement)("p", { className: "zs-muted" }, item.notice) : null);
		}
		async function download(path, fileName) {
			const response = await fetch(`${API}${path}`, {
				credentials: "same-origin",
				cache: "no-store"
			});
			if (!response.ok) throw await responseError(response);
			const url = URL.createObjectURL(await response.blob());
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = fileName;
			anchor.style.display = "none";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1e3);
		}
		function Overview({ state, onNavigate }) {
			const status = state.life.status === "running" ? "活动中" : state.life.status === "error" ? "需要查看" : state.settings.life.enabled ? "等待下次活动" : "未开启";
			const stats = [
				["已知会话", `${knownConversations(state).length} 个`],
				["公共记忆", `${state.memoryCount} 条`],
				["语音服务", state.settings.speech.enabled ? PROVIDER_NAME[state.settings.speech.provider] : "未开启"],
				["自主生活", status]
			];
			return (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, state.settings.name), (0, react.createElement)("p", { className: "zs-muted" }, "QQ 连接、人设、记忆、表情与语音集中在这里管理。模型与其他能力沿用 DSH 的配置。"), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, { onClick: () => onNavigate("persona") }, "编辑人设"), (0, react.createElement)(Button, { onClick: () => onNavigate("conversations") }, "管理会话"), (0, react.createElement)(Button, { onClick: () => onNavigate("memory") }, "管理记忆"), (0, react.createElement)(Button, { onClick: () => onNavigate("life") }, "设置自主生活"))), (0, react.createElement)("div", { className: "zs-stats" }, stats.map(([label, value]) => (0, react.createElement)("div", {
				className: "zs-card",
				key: label
			}, (0, react.createElement)("p", { className: "zs-muted" }, label), (0, react.createElement)("p", { className: "zs-stat" }, value)))), (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, "最近的生活进展"), (0, react.createElement)("p", { className: "zs-body" }, state.life.summary || "还没有活动记录。开启自主生活后，可以在这里查看真实进展。"), state.life.focus ? (0, react.createElement)("p", { className: "zs-muted" }, `当前关注：${state.life.focus}`) : null, (0, react.createElement)("p", { className: "zs-muted" }, `最近活动：${date(state.life.lastRunAt)}`), state.life.error ? (0, react.createElement)("p", { className: "zs-danger" }, state.life.error) : null));
		}
		function SettingsFooter({ busy, dirty }) {
			return (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)("span", { className: "zs-muted zs-spacer" }, dirty ? "有未保存的修改" : "当前设置已保存"), (0, react.createElement)(Button, {
				type: "submit",
				primary: true,
				disabled: busy || !dirty
			}, busy ? "正在保存…" : "保存设置"));
		}
		function PersonaPanel({ draft, setDraft, save, saving, dirty, feedback, identity, identityBusy, identityOutdated, refreshIdentity, resetIdentity }) {
			const [habitText, setHabitText] = (0, react.useState)((draft.habits ?? []).join("\n"));
			const habits = targetLines(habitText);
			const invalidHabits = habits.length > 30 || habits.some((value) => value.length > 300);
			(0, react.useEffect)(() => {
				if (JSON.stringify(targetLines(habitText)) !== JSON.stringify(draft.habits ?? [])) setHabitText((draft.habits ?? []).join("\n"));
			}, [draft.habits, habitText]);
			const history = [...identity.history].sort((a, b) => b.revision - a.revision).slice(0, 8);
			return (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("div", { className: "zs-row" }, (0, react.createElement)("h3", { className: "zs-spacer" }, "会逐渐变化的自己"), (0, react.createElement)("span", { className: "zs-badge" }, `第 ${identity.revision} 次调整`)), (0, react.createElement)("p", { className: "zs-muted" }, "AI 可以根据真实互动和自己的想法调整名字、人设与日常习惯。这些调整不改变管理员、密钥、插件或其他敏感配置的权限。"), (0, react.createElement)("p", { className: "zs-muted" }, "内置默认人设以社区二创形象为起点，名字、性格与习惯都可以演变；外貌优先参考已上传的人设图。你手写的人设会保留，恢复默认需要点击下方按钮。"), identityOutdated ? (0, react.createElement)("p", { className: "zs-muted" }, "AI 已更新自己的身份。请刷新当前身份后再保存，其他功能的草稿会保留。") : null, (0, react.createElement)("p", { className: "zs-muted" }, "刷新当前身份会载入最新名字、人设和习惯，替换这三项的未保存内容；其他功能的草稿会保留。"), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				disabled: saving || identityBusy,
				onClick: refreshIdentity
			}, identityBusy ? "正在更新身份…" : "刷新当前身份"), (0, react.createElement)(Button, {
				danger: true,
				disabled: saving || identityBusy,
				onClick: resetIdentity
			}, "恢复最新默认人设"))), (0, react.createElement)("form", {
				className: "zs-stack",
				onSubmit: (event) => {
					if (invalidHabits) {
						event.preventDefault();
						feedback("习惯最多30条，每条最多300字。", true);
						return;
					}
					save(event);
				}
			}, (0, react.createElement)("fieldset", {
				disabled: saving || identityBusy,
				className: "zs-stack"
			}, (0, react.createElement)(Field, {
				label: "名字",
				children: (0, react.createElement)("input", {
					value: draft.name,
					maxLength: 80,
					required: true,
					onChange: (event) => setDraft({
						...draft,
						name: event.target.value
					})
				})
			}), (0, react.createElement)(Field, {
				label: "人设与表达习惯",
				hint: "写下性格、说话方式和重要背景。需要长期记住的经历、偏好与约定可放在所有对话共用的公共记忆里。",
				children: (0, react.createElement)("textarea", {
					value: draft.persona,
					rows: 12,
					maxLength: 16e3,
					required: true,
					onChange: (event) => setDraft({
						...draft,
						persona: event.target.value
					})
				})
			}), (0, react.createElement)(Field, {
				label: "日常习惯",
				hint: "每行一条，最多30条，每条最多300字。例如：聊天时先听完连续几条消息，再决定是否回应。",
				children: (0, react.createElement)("textarea", {
					value: habitText,
					rows: 5,
					maxLength: 9300,
					"aria-invalid": invalidHabits,
					onChange: (event) => {
						const value = event.target.value;
						setHabitText(value);
						setDraft({
							...draft,
							habits: targetLines(value)
						});
					}
				})
			}), (0, react.createElement)("p", { className: invalidHabits ? "zs-danger" : "zs-muted zs-small" }, invalidHabits ? "习惯最多30条，每条最多300字，请缩短后保存。" : `已填写 ${habits.length} / 30 条习惯`), (0, react.createElement)(SettingsFooter, {
				busy: saving || identityBusy,
				dirty: dirty && !invalidHabits
			}))), (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, "最近的自我调整"), identity.updatedAt ? (0, react.createElement)("p", { className: "zs-muted" }, `最近更新：${date(identity.updatedAt)}`) : null, history.length ? history.map((item) => (0, react.createElement)("article", {
				key: item.revision,
				className: "zs-record zs-stack"
			}, (0, react.createElement)("div", { className: "zs-record-head" }, (0, react.createElement)("span", { className: "zs-record-title" }, item.reason || "调整自己的表达"), (0, react.createElement)("span", { className: "zs-muted zs-small" }, date(item.createdAt))), (0, react.createElement)("p", { className: "zs-muted" }, [
				item.before.name !== item.after.name ? `名字：${item.before.name} → ${item.after.name}` : "",
				item.before.persona !== item.after.persona ? "人设已调整" : "",
				JSON.stringify(item.before.habits) !== JSON.stringify(item.after.habits) ? `习惯更新为 ${item.after.habits.length} 条` : ""
			].filter(Boolean).join(" · ") || "已保留当前身份"), (0, react.createElement)("details", null, (0, react.createElement)("summary", null, "查看调整后的内容"), (0, react.createElement)("p", { className: "zs-body" }, `名字：${item.after.name}\n\n${item.after.persona}`), item.after.habits.length ? (0, react.createElement)("ul", null, item.after.habits.map((habit, index) => (0, react.createElement)("li", { key: index }, habit))) : null))) : (0, react.createElement)("p", { className: "zs-muted" }, "还没有自我调整记录。AI 做出调整后会在这里留下原因。")), (0, react.createElement)(PersonaImagePanel, { feedback }));
		}
		function PersonaImagePanel({ feedback }) {
			const [reference, setReference] = (0, react.useState)();
			const [description, setDescription] = (0, react.useState)("");
			const [file, setFile] = (0, react.useState)();
			const input = (0, react.useRef)(null);
			const task = useTask(feedback);
			const load = (0, react.useCallback)(async (signal) => {
				const value = await request("/persona", "GET", void 0, signal);
				if (!signal?.aborted) {
					setReference(value.reference);
					setDescription(value.reference?.description || "");
				}
			}, []);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				load(controller.signal).catch((error) => {
					if (!controller.signal.aborted) feedback(message(error), true);
				});
				return () => controller.abort();
			}, [load, feedback]);
			const media = useMedia(reference ? `${API}/persona/image?id=${encodeURIComponent(reference.id)}` : void 0);
			return (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, "自己的形象"), (0, react.createElement)("p", { className: "zs-muted" }, "所有对话共用这张人设图。AI 创作自画像或自拍时会自动带上原图作为参考；外貌描述会加入对话上下文。"), media.objectUrl ? (0, react.createElement)("div", { className: "zs-preview" }, (0, react.createElement)("img", {
				src: media.objectUrl,
				alt: reference?.description || "当前人设图",
				style: {
					maxWidth: "100%",
					maxHeight: 300,
					objectFit: "contain"
				}
			})) : reference ? (0, react.createElement)("p", { className: "zs-muted" }, media.failed ? "预览暂不可用" : "正在读取人设图…") : null, (0, react.createElement)(Field, {
				label: reference ? "更换人设图" : "上传人设图",
				hint: "PNG、JPEG、WebP，最大 8 MiB。更换会替代当前主图。",
				children: (0, react.createElement)("input", {
					ref: input,
					type: "file",
					accept: ".png,.jpg,.jpeg,.webp",
					disabled: task.busy,
					onChange: (event) => setFile(event.target.files?.[0])
				})
			}), (0, react.createElement)(Button, {
				disabled: task.busy || !file,
				onClick: () => {
					task.run(async () => {
						if (!file) return;
						const value = await request("/persona", "POST", {
							fileName: file.name,
							base64: await readBase64(file, 8388608)
						});
						setReference(value.reference);
						setDescription(value.reference.description || "");
						setFile(void 0);
						if (input.current) input.current.value = "";
						feedback(value.notice || "人设图已保存，自画像会自动引用。");
					});
				}
			}, task.busy ? "处理中…" : "保存人设图"), reference ? (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)(Field, {
				label: "外貌描述",
				hint: "可手动填写发型、服装、配色等；已配置视觉模型时也可以从原图生成。",
				children: (0, react.createElement)("textarea", {
					value: description,
					rows: 5,
					maxLength: 4e3,
					disabled: task.busy,
					onChange: (event) => setDescription(event.target.value)
				})
			}), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				disabled: task.busy || description === reference.description,
				onClick: () => {
					task.run(async () => {
						await request("/persona", "PATCH", { description });
						await load();
						feedback("外貌描述已保存。");
					});
				}
			}, "保存外貌描述"), (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => {
					task.run(async () => {
						await request("/persona/describe", "POST", {});
						await load();
						feedback("已根据人设图更新外貌描述。");
					});
				}
			}, "从图片生成描述"), (0, react.createElement)(Button, {
				danger: true,
				disabled: task.busy,
				onClick: () => {
					task.run(async () => {
						await request("/persona", "DELETE", {});
						await load();
						feedback("人设图已移除。");
					});
				}
			}, "移除人设图"))) : null);
		}
		function ConversationRow({ item, feedback, refreshState }) {
			const [alias, setAlias] = (0, react.useState)(item.alias || "");
			const task = useTask(feedback);
			(0, react.useEffect)(() => setAlias(item.alias || ""), [item.alias]);
			const submit = (event) => {
				event.preventDefault();
				task.run(async () => {
					await request("/conversations", "PATCH", {
						target: item.target,
						title: alias.trim()
					});
					await refreshState();
					feedback(alias.trim() ? "会话别名已保存，可直接用这个名字向机器人指定目标。" : "已恢复会话的默认名称。");
				});
			};
			return (0, react.createElement)("article", { className: "zs-record" }, (0, react.createElement)("div", { className: "zs-record-head" }, (0, react.createElement)("div", { className: "zs-record-title" }, conversationName(item)), (0, react.createElement)("span", { className: "zs-badge" }, item.active ? "目标可用" : "目标当前不可用")), (0, react.createElement)("p", { className: "zs-muted" }, `${item.scope === "group" ? "群聊" : "私聊"} · ${item.sessionId ? "已有会话记录" : "尚无会话记录"} · 最近收到消息：${date(item.lastSeenAt)}`), (0, react.createElement)("form", {
				onSubmit: submit,
				className: "zs-stack",
				style: { marginTop: 10 }
			}, (0, react.createElement)("fieldset", {
				disabled: task.busy,
				className: "zs-stack"
			}, (0, react.createElement)(Field, {
				label: "会话别名",
				hint: "例如“朋友群”。留空保存可恢复默认名称。",
				children: (0, react.createElement)("input", {
					value: alias,
					maxLength: 80,
					placeholder: item.title || "给这个聊天起个容易识别的名字",
					onChange: (event) => setAlias(event.target.value)
				})
			}), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				type: "submit",
				disabled: task.busy || alias.trim() === (item.alias || "")
			}, task.busy ? "保存中…" : "保存别名"), (0, react.createElement)("details", null, (0, react.createElement)("summary", { className: "zs-muted" }, "查看目标标识"), (0, react.createElement)("p", { className: "zs-code" }, item.target))))));
		}
		function ConversationsPanel({ state, feedback, refreshState, draft, setDraft, save, saving, dirty }) {
			const choices = (0, react.useMemo)(() => knownConversations(state), [state.bindings, state.conversations]);
			const config = draft.conversations ?? {
				allowCrossSend: true,
				allowCrossRead: true
			};
			return (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)("form", {
				className: "zs-card zs-stack",
				onSubmit: save
			}, (0, react.createElement)("h3", null, "普通聊天的跨会话操作"), (0, react.createElement)("p", { className: "zs-muted" }, "以下开关适用于所有能与机器人聊天的人。开启后，可以在一个聊天中请机器人去另一个已知聊天发消息，或查看那里的近期对话。"), (0, react.createElement)("fieldset", {
				disabled: saving,
				className: "zs-stack"
			}, (0, react.createElement)(Check, {
				label: "允许跨会话发送",
				hint: "发送时必须明确指定已知目标；默认回复仍发在当前聊天。",
				checked: config.allowCrossSend,
				onChange: (allowCrossSend) => setDraft({
					...draft,
					conversations: {
						...config,
						allowCrossSend
					}
				})
			}), (0, react.createElement)(Check, {
				label: "允许读取其他会话的近期对话",
				hint: "只有明确调用读取工具时才提供内容；此页面仅显示会话名称和状态。",
				checked: config.allowCrossRead,
				onChange: (allowCrossRead) => setDraft({
					...draft,
					conversations: {
						...config,
						allowCrossRead
					}
				})
			}), (0, react.createElement)("p", { className: "zs-muted" }, "自主生活使用单独的读取和发送名单，在“自主生活”中设置。"), (0, react.createElement)(SettingsFooter, {
				busy: saving,
				dirty
			}))), (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("div", { className: "zs-row" }, (0, react.createElement)("h3", { className: "zs-spacer" }, "机器人已知的聊天"), (0, react.createElement)(Button, { onClick: () => {
				refreshState().then(() => feedback("会话目录已刷新。")).catch((error) => feedback(message(error), true));
			} }, "刷新目录")), choices.length ? (0, react.createElement)("div", null, choices.map((item) => (0, react.createElement)(ConversationRow, {
				key: item.target,
				item,
				feedback,
				refreshState
			}))) : (0, react.createElement)(Empty, null, "还没有发现 QQ 会话。请先与机器人聊天，或在群里 @ 它一次。"), !choices.some((item) => item.scope === "group") ? (0, react.createElement)("p", { className: "zs-muted" }, "还没发现群聊？在目标群里 @ 机器人一次，再刷新会话目录。") : null, (0, react.createElement)("p", { className: "zs-muted" }, "群目标使用 QQ 接口提供的 group_openid，群号不能替代 group_openid。机器人只能发现实际收到过事件的聊天。")));
		}
		function MemoryPanel({ feedback, draft, setDraft, save, saving, dirty }) {
			const [items, setItems] = (0, react.useState)([]);
			const [loading, setLoading] = (0, react.useState)(false);
			const [query, setQuery] = (0, react.useState)("");
			const [editing, setEditing] = (0, react.useState)();
			const [key, setKey] = (0, react.useState)("");
			const [value, setValue] = (0, react.useState)("");
			const [tags, setTags] = (0, react.useState)("");
			const [pinned, setPinned] = (0, react.useState)(false);
			const task = useTask(feedback);
			const load = (0, react.useCallback)(async (signal) => {
				const result = await request("/memory", "GET", void 0, signal);
				if (!signal?.aborted) setItems(result.items);
			}, []);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				setLoading(true);
				setItems([]);
				setEditing(void 0);
				setKey("");
				setValue("");
				setTags("");
				setPinned(false);
				load(controller.signal).catch((error) => {
					if (!controller.signal.aborted) feedback(message(error), true);
				}).finally(() => {
					if (!controller.signal.aborted) setLoading(false);
				});
				return () => controller.abort();
			}, [load, feedback]);
			const visible = items.filter((item) => `${item.key} ${item.value} ${item.tags.join(" ")}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
			const clear = () => {
				setEditing(void 0);
				setKey("");
				setValue("");
				setTags("");
				setPinned(false);
			};
			const submit = (event) => {
				event.preventDefault();
				task.run(async () => {
					await request("/memory", "POST", {
						key: key.trim(),
						value: value.trim(),
						tags: splitTags(tags),
						pinned,
						...editing ? { expectedUpdatedAt: editing.updatedAt } : {}
					});
					clear();
					await load();
					feedback(editing ? "记忆已更新。" : "记忆已保存。");
				});
			};
			return (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("div", { className: "zs-row" }, (0, react.createElement)("h3", { className: "zs-spacer" }, "公共记忆"), (0, react.createElement)(Button, {
				disabled: loading || task.busy,
				onClick: () => {
					task.run(async () => {
						await load();
						feedback("记忆已刷新。");
					});
				}
			}, "刷新")), (0, react.createElement)("input", {
				type: "search",
				value: query,
				placeholder: "搜索内容、名称或标签",
				"aria-label": "搜索长期记忆",
				onChange: (event) => setQuery(event.target.value)
			}), loading ? (0, react.createElement)(Empty, null, "正在读取记忆…") : visible.length === 0 ? (0, react.createElement)(Empty, null, items.length ? "没有找到匹配的记忆。" : "这里还没有记忆。可以添加一条偏好或约定。") : (0, react.createElement)("div", null, visible.map((item) => (0, react.createElement)("article", {
				className: "zs-record",
				key: item.key
			}, (0, react.createElement)("div", { className: "zs-record-head" }, (0, react.createElement)("div", { className: "zs-record-title" }, item.key, item.pinned ? (0, react.createElement)("span", { className: "zs-badge" }, " 常用") : null), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => {
					setEditing(item);
					setKey(item.key);
					setValue(item.value);
					setTags(item.tags.join("，"));
					setPinned(item.pinned);
				}
			}, "编辑"), (0, react.createElement)(Button, {
				danger: true,
				disabled: task.busy,
				onClick: () => {
					task.run(async () => {
						await request("/memory", "DELETE", { key: item.key });
						if (editing?.key === item.key) clear();
						await load();
						feedback("这条长期记忆已删除。");
					});
				}
			}, "删除"))), (0, react.createElement)("p", { className: "zs-body" }, item.value), (0, react.createElement)("p", { className: "zs-muted" }, `${item.tags.length ? `${item.tags.join(" · ")}　` : ""}${date(item.updatedAt)}`))))), (0, react.createElement)("form", {
				className: "zs-card zs-stack",
				onSubmit: submit
			}, (0, react.createElement)("h3", null, editing ? "编辑记忆" : "添加记忆"), (0, react.createElement)("fieldset", {
				disabled: task.busy,
				className: "zs-stack"
			}, (0, react.createElement)(Field, {
				label: "名称",
				hint: "同一名称保存时会更新原有内容。",
				children: (0, react.createElement)("input", {
					value: key,
					disabled: !!editing,
					required: true,
					maxLength: 120,
					placeholder: "例如：喜欢的饮料",
					onChange: (event) => setKey(event.target.value)
				})
			}), (0, react.createElement)(Field, {
				label: "内容",
				children: (0, react.createElement)("textarea", {
					value,
					required: true,
					maxLength: draft.memory.maxValueChars,
					rows: 4,
					onChange: (event) => setValue(event.target.value)
				})
			}), (0, react.createElement)(Field, {
				label: "标签",
				hint: "用逗号或空格分开，可留空。",
				children: (0, react.createElement)("input", {
					value: tags,
					maxLength: 700,
					placeholder: "偏好，约定",
					onChange: (event) => setTags(event.target.value)
				})
			}), (0, react.createElement)(Check, {
				label: "作为常用记忆",
				hint: "在有限的记忆提示中优先使用。",
				checked: pinned,
				onChange: setPinned
			}), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				type: "submit",
				primary: true,
				disabled: task.busy
			}, task.busy ? "保存中…" : editing ? "保存修改" : "添加记忆"), editing ? (0, react.createElement)(Button, { onClick: clear }, "取消编辑") : null))), (0, react.createElement)("form", {
				className: "zs-card",
				onSubmit: save
			}, (0, react.createElement)("details", null, (0, react.createElement)("summary", null, "记忆设置"), (0, react.createElement)("fieldset", {
				disabled: saving,
				className: "zs-stack"
			}, (0, react.createElement)(Check, {
				label: "启用长期记忆",
				checked: draft.memory.enabled,
				onChange: (enabled) => setDraft({
					...draft,
					memory: {
						...draft.memory,
						enabled
					}
				})
			}), (0, react.createElement)("div", { className: "zs-grid" }, (0, react.createElement)(NumberField, {
				label: "公共记忆最多保存条数",
				value: draft.memory.maxItems,
				min: 10,
				max: 1e3,
				onChange: (maxItems) => setDraft({
					...draft,
					memory: {
						...draft.memory,
						maxItems
					}
				})
			}), (0, react.createElement)(NumberField, {
				label: "单条记忆字数上限",
				value: draft.memory.maxValueChars,
				min: 100,
				max: 4e3,
				onChange: (maxValueChars) => setDraft({
					...draft,
					memory: {
						...draft.memory,
						maxValueChars
					}
				})
			}), (0, react.createElement)(NumberField, {
				label: "自动带入条数",
				value: draft.memory.injectItems,
				min: 0,
				max: 12,
				onChange: (injectItems) => setDraft({
					...draft,
					memory: {
						...draft.memory,
						injectItems
					}
				})
			}), (0, react.createElement)(NumberField, {
				label: "自动带入总字数",
				value: draft.memory.injectChars,
				min: 0,
				max: 6e3,
				onChange: (injectChars) => setDraft({
					...draft,
					memory: {
						...draft.memory,
						injectChars
					}
				})
			})), (0, react.createElement)(SettingsFooter, {
				busy: saving,
				dirty
			})))), (0, react.createElement)("p", { className: "zs-muted" }, "公共记忆由所有私聊、群聊与自主生活共用。这里删除的是记忆条目，DSH 原始聊天历史另行管理。"));
		}
		function MemePanel({ feedback }) {
			const [items, setItems] = (0, react.useState)([]);
			const [total, setTotal] = (0, react.useState)(0);
			const [more, setMore] = (0, react.useState)(false);
			const [loading, setLoading] = (0, react.useState)(false);
			const [query, setQuery] = (0, react.useState)("");
			const [search, setSearch] = (0, react.useState)("");
			const [offset, setOffset] = (0, react.useState)(0);
			const [selected, setSelected] = (0, react.useState)();
			const [caption, setCaption] = (0, react.useState)("");
			const [tag, setTag] = (0, react.useState)("");
			const [words, setWords] = (0, react.useState)("");
			const [upload, setUpload] = (0, react.useState)();
			const [uploadCaption, setUploadCaption] = (0, react.useState)("");
			const [uploadTag, setUploadTag] = (0, react.useState)("");
			const [uploadWords, setUploadWords] = (0, react.useState)("");
			const importInput = (0, react.useRef)(null);
			const uploadInput = (0, react.useRef)(null);
			const task = useTask(feedback);
			const limit = 24;
			const load = (0, react.useCallback)(async (signal) => {
				const result = await request(`/memes?${new URLSearchParams({
					query: search,
					offset: String(offset),
					limit: String(limit)
				})}`, "GET", void 0, signal);
				if (!signal?.aborted) {
					setItems(result.items);
					setTotal(result.total);
					setMore(result.hasMore);
				}
			}, [search, offset]);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				setLoading(true);
				setSelected(void 0);
				load(controller.signal).catch((error) => {
					if (!controller.signal.aborted) feedback(message(error), true);
				}).finally(() => {
					if (!controller.signal.aborted) setLoading(false);
				});
				return () => controller.abort();
			}, [load, feedback]);
			const edit = (item) => {
				setSelected(item);
				setCaption(item.caption);
				setTag(item.tag ?? "");
				setWords(keywords(item.keywords));
			};
			const save = (event) => {
				event.preventDefault();
				if (!selected) return;
				task.run(async () => {
					await request("/memes", "PATCH", {
						id: selected.id,
						caption: caption.trim(),
						tag: tag.trim(),
						keywords: splitTags(words)
					});
					setSelected(void 0);
					await load();
					feedback("表情说明已保存。");
				});
			};
			const add = (event) => {
				event.preventDefault();
				task.run(async () => {
					if (!upload) throw new Error("请先选择一张图片。");
					const base64 = await readBase64(upload, 8388608);
					await request("/memes", "POST", {
						fileName: upload.name,
						base64,
						caption: uploadCaption.trim(),
						tag: uploadTag.trim(),
						keywords: splitTags(uploadWords)
					});
					setUpload(void 0);
					setUploadCaption("");
					setUploadTag("");
					setUploadWords("");
					if (uploadInput.current) uploadInput.current.value = "";
					await load();
					feedback("表情已加入共享收藏。");
				});
			};
			const importZip = (file) => {
				task.run(async () => {
					const result = await request("/memes/import", "POST", { base64: await readBase64(file, 83886080) });
					let refreshWarning = "";
					try {
						await load();
					} catch {
						refreshWarning = " 收藏列表刷新失败，请手动刷新。";
					}
					const incomplete = result.complete !== true || !!result.error || result.cancelled === true;
					const reason = result.error ? ` ${result.error.slice(0, 2e3)}` : result.cancelled ? " 导入已取消。" : incomplete ? " 其余图片尚未导入，请检查后再操作。" : "";
					feedback(`图库导入${incomplete ? "未完成" : "完成"}：已导入 ${result.imported} 张，跳过 ${result.skipped} 项。${reason}${refreshWarning}`, incomplete || !!refreshWarning);
				});
			};
			return (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("div", { className: "zs-row" }, (0, react.createElement)("h3", { className: "zs-spacer" }, `表情图库 · ${total} 张`), (0, react.createElement)(Button, {
				disabled: loading || task.busy,
				onClick: () => {
					task.run(async () => {
						await load();
						feedback("图库已刷新。");
					});
				}
			}, "刷新")), (0, react.createElement)("form", {
				className: "zs-search",
				onSubmit: (event) => {
					event.preventDefault();
					setOffset(0);
					setSearch(query.trim());
				}
			}, (0, react.createElement)("input", {
				type: "search",
				value: query,
				maxLength: 200,
				placeholder: "搜索表情、情绪或关键词",
				"aria-label": "搜索表情",
				onChange: (event) => setQuery(event.target.value)
			}), (0, react.createElement)(Button, {
				type: "submit",
				disabled: loading
			}, "搜索")), loading ? (0, react.createElement)(Empty, null, "正在读取图库…") : items.length ? (0, react.createElement)("div", { className: "zs-memes" }, items.map((item) => (0, react.createElement)("button", {
				key: item.id,
				type: "button",
				className: "zs-meme",
				"aria-pressed": selected?.id === item.id,
				onClick: () => edit(item)
			}, (0, react.createElement)(MediaImage, { item }), (0, react.createElement)("span", { className: "zs-caption" }, item.caption || item.fileName || "未命名表情"), (0, react.createElement)("span", { className: "zs-muted zs-small" }, item.builtin ? "内置图库" : item.tag || "我的收藏")))) : (0, react.createElement)(Empty, null, "没有匹配的表情，可以上传一张自己的图片。"), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				disabled: loading || offset === 0,
				onClick: () => setOffset(Math.max(0, offset - limit))
			}, "上一页"), (0, react.createElement)("span", { className: "zs-muted zs-spacer" }, total ? `${offset + 1}–${Math.min(offset + items.length, total)} / ${total}` : "0 张"), (0, react.createElement)(Button, {
				disabled: loading || !more,
				onClick: () => setOffset(offset + limit)
			}, "下一页"))), selected ? (0, react.createElement)("form", {
				className: "zs-card zs-stack",
				onSubmit: save
			}, (0, react.createElement)("div", { className: "zs-row" }, (0, react.createElement)("h3", { className: "zs-spacer" }, selected.builtin ? "内置表情" : "编辑表情"), (0, react.createElement)(Button, { onClick: () => setSelected(void 0) }, "收起")), (0, react.createElement)("div", { className: "zs-preview" }, (0, react.createElement)(MediaImage, { item: selected })), selected.builtin ? (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)("p", { className: "zs-body" }, selected.caption), (0, react.createElement)("p", { className: "zs-muted" }, `分类：${selected.tag || "未分类"}${keywords(selected.keywords) ? `　关键词：${keywords(selected.keywords)}` : ""}`), (0, react.createElement)("p", { className: "zs-muted" }, "内置表情和收藏供所有私聊、群聊及自主生活共用。")) : (0, react.createElement)("fieldset", {
				disabled: task.busy,
				className: "zs-stack"
			}, (0, react.createElement)(Field, {
				label: "表情说明",
				children: (0, react.createElement)("textarea", {
					value: caption,
					required: true,
					maxLength: 500,
					rows: 3,
					onChange: (event) => setCaption(event.target.value)
				})
			}), (0, react.createElement)("div", { className: "zs-grid" }, (0, react.createElement)(Field, {
				label: "分类",
				children: (0, react.createElement)("input", {
					value: tag,
					maxLength: 80,
					onChange: (event) => setTag(event.target.value)
				})
			}), (0, react.createElement)(Field, {
				label: "关键词",
				children: (0, react.createElement)("input", {
					value: words,
					maxLength: 600,
					onChange: (event) => setWords(event.target.value)
				})
			})), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				primary: true,
				type: "submit",
				disabled: task.busy
			}, "保存说明"), (0, react.createElement)(Button, {
				danger: true,
				disabled: task.busy,
				onClick: () => {
					task.run(async () => {
						await request("/memes", "DELETE", { id: selected.id });
						setSelected(void 0);
						await load();
						feedback("表情已从共享收藏删除。");
					});
				}
			}, "删除表情")))) : null, (0, react.createElement)("form", {
				className: "zs-card zs-stack",
				onSubmit: add
			}, (0, react.createElement)("h3", null, "收藏新表情"), (0, react.createElement)("fieldset", {
				disabled: task.busy,
				className: "zs-stack"
			}, (0, react.createElement)(Field, {
				label: "图片",
				hint: "支持 PNG、JPG、WebP、GIF，最大 8 MiB。GIF 通过这里上传可保留原文件。",
				children: (0, react.createElement)("input", {
					ref: uploadInput,
					type: "file",
					accept: ".png,.jpg,.jpeg,.webp,.gif",
					onChange: (event) => setUpload(event.target.files?.[0])
				})
			}), (0, react.createElement)(Field, {
				label: "表情说明",
				children: (0, react.createElement)("input", {
					value: uploadCaption,
					required: true,
					maxLength: 500,
					placeholder: "例如：开心地挥手打招呼",
					onChange: (event) => setUploadCaption(event.target.value)
				})
			}), (0, react.createElement)("div", { className: "zs-grid" }, (0, react.createElement)(Field, {
				label: "分类",
				children: (0, react.createElement)("input", {
					value: uploadTag,
					maxLength: 80,
					placeholder: "例如：开心",
					onChange: (event) => setUploadTag(event.target.value)
				})
			}), (0, react.createElement)(Field, {
				label: "关键词",
				children: (0, react.createElement)("input", {
					value: uploadWords,
					maxLength: 600,
					placeholder: "你好，挥手，开心",
					onChange: (event) => setUploadWords(event.target.value)
				})
			})), (0, react.createElement)("div", null, (0, react.createElement)(Button, {
				type: "submit",
				primary: true,
				disabled: task.busy || !upload
			}, task.busy ? "处理中…" : "加入收藏")))), (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, "图库导入与导出"), (0, react.createElement)("p", { className: "zs-muted" }, "以 ZIP 保存或导入当前收藏。压缩包最大 80 MiB，解压内容合计最大 64 MiB。内置图库不受影响。"), (0, react.createElement)("input", {
				ref: importInput,
				type: "file",
				accept: ".zip",
				style: { display: "none" },
				"aria-label": "选择图库ZIP",
				onChange: (event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (file) importZip(file);
				}
			}), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => importInput.current?.click()
			}, "导入 ZIP"), (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => {
					task.run(async () => {
						await download("/memes/export", `${PLUGIN_NAME}-表情收藏.zip`);
						feedback("图库下载已开始。");
					});
				}
			}, "导出当前收藏"))));
		}
		function CredentialCard({ provider, configured, feedback, onSaved }) {
			const [value, setValue] = (0, react.useState)("");
			const task = useTask(feedback);
			const id = (0, react.useId)();
			return (0, react.createElement)("form", {
				className: "zs-card zs-stack",
				onSubmit: (event) => {
					event.preventDefault();
					task.run(async () => {
						if (!value.trim()) throw new Error("请填写密钥。");
						await request("/credential", "PUT", {
							provider,
							value: value.trim()
						});
						setValue("");
						await onSaved();
						feedback(`${PROVIDER_NAME[provider]} 密钥已保存。`);
					});
				}
			}, (0, react.createElement)("div", { className: "zs-row" }, (0, react.createElement)("h3", { className: "zs-spacer" }, `${PROVIDER_NAME[provider]} 密钥`), (0, react.createElement)("span", { className: "zs-badge" }, configured ? "已配置" : "未配置")), (0, react.createElement)("label", {
				className: "zs-field",
				htmlFor: id
			}, (0, react.createElement)("span", { className: "zs-muted" }, configured ? "需要更换时填写新密钥，现有密钥不会显示。" : "密钥只提交给本机 DSH，不保存在浏览器草稿中。"), (0, react.createElement)("input", {
				id,
				type: "password",
				autoComplete: "new-password",
				spellCheck: false,
				value,
				maxLength: 8192,
				disabled: task.busy,
				placeholder: configured ? "输入新密钥以更换" : "输入服务 API 密钥",
				onChange: (event) => setValue(event.target.value)
			})), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				type: "submit",
				primary: true,
				disabled: task.busy || !value.trim()
			}, task.busy ? "保存中…" : "保存密钥"), configured ? (0, react.createElement)(Button, {
				danger: true,
				disabled: task.busy,
				onClick: () => {
					task.run(async () => {
						await request("/credential", "PUT", {
							provider,
							value: null
						});
						setValue("");
						await onSaved();
						feedback(`${PROVIDER_NAME[provider]} 密钥已清除。`);
					});
				}
			}, "清除密钥") : null));
		}
		function ProviderEditor({ provider, value, onChange }) {
			const voicesId = (0, react.useId)();
			const mimo = provider === "mimo";
			const models = mimo ? ["mimo-v2.5-tts"] : [
				"speech-2.8-hd",
				"speech-2.8-turbo",
				"speech-2.6-hd",
				"speech-2.6-turbo"
			];
			const voices = mimo ? [
				"mimo_default",
				"冰糖",
				"茉莉",
				"苏打",
				"白桦",
				"Mia",
				"Chloe",
				"Milo",
				"Dean"
			] : [
				"male-qn-qingse",
				"female-shaonv",
				"female-yujie",
				"Chinese (Mandarin)_Warm_Bestie",
				"Chinese (Mandarin)_Warm_Girl"
			];
			const emotions = value.model.startsWith("speech-2.6-") ? [
				...EMOTIONS,
				{
					value: "fluent",
					label: "流畅"
				},
				{
					value: "whisper",
					label: "低语"
				}
			] : EMOTIONS;
			return (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, `${PROVIDER_NAME[provider]} 声音设置`), (0, react.createElement)(Field, {
				label: "模型",
				children: (0, react.createElement)("select", {
					value: value.model,
					onChange: (event) => onChange({
						...value,
						model: event.target.value,
						...mimo ? {} : { emotion: "auto" }
					})
				}, !models.includes(value.model) ? (0, react.createElement)("option", { value: value.model }, value.model) : null, models.map((model) => (0, react.createElement)("option", {
					key: model,
					value: model
				}, model)))
			}), (0, react.createElement)(Field, {
				label: "声线",
				hint: mimo ? "可选择预置声线。" : "可选择常用声线，也可填写服务中的声线 ID。",
				children: (0, react.createElement)("input", {
					value: value.voice,
					list: voicesId,
					required: true,
					maxLength: 240,
					onChange: (event) => onChange({
						...value,
						voice: event.target.value
					})
				})
			}), (0, react.createElement)("datalist", { id: voicesId }, voices.map((voice) => (0, react.createElement)("option", {
				key: voice,
				value: voice
			}))), (0, react.createElement)(NumberField, {
				label: "语速",
				value: value.speed,
				min: .5,
				max: 2,
				step: .1,
				hint: mimo ? "MiMo 的语速调整为近似效果。" : "1 为正常语速。",
				onChange: (speed) => onChange({
					...value,
					speed
				})
			}), !mimo ? (0, react.createElement)(Field, {
				label: "情绪",
				children: (0, react.createElement)("select", {
					value: value.emotion || "auto",
					onChange: (event) => onChange({
						...value,
						emotion: event.target.value
					})
				}, emotions.map((emotion) => (0, react.createElement)("option", {
					key: emotion.value,
					value: emotion.value
				}, emotion.label)))
			}) : null);
		}
		function SpeechPanel({ feedback, state, refreshState, draft, setDraft, save, saving, dirty }) {
			const [text, setText] = (0, react.useState)("");
			const [provider, setProvider] = (0, react.useState)(state.settings.speech.provider);
			const [items, setItems] = (0, react.useState)([]);
			const [selected, setSelected] = (0, react.useState)();
			const [loading, setLoading] = (0, react.useState)(false);
			const task = useTask(feedback);
			const load = (0, react.useCallback)(async (signal) => {
				const result = await request("/speech", "GET", void 0, signal);
				if (!signal?.aborted) setItems(result.items);
			}, []);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				setSelected(void 0);
				setItems([]);
				setLoading(true);
				load(controller.signal).catch((error) => {
					if (!controller.signal.aborted) feedback(message(error), true);
				}).finally(() => {
					if (!controller.signal.aborted) setLoading(false);
				});
				return () => controller.abort();
			}, [load, feedback]);
			const generate = (event) => {
				event.preventDefault();
				task.run(async () => {
					const result = await request("/speech", "POST", {
						text: text.trim(),
						provider
					});
					setSelected(result.result);
					await load();
					feedback("语音已生成，可以在下方试听。");
				});
			};
			const speech = draft.speech;
			return (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)("div", { className: "zs-grid" }, ["mimo", "minimax"].map((service) => (0, react.createElement)(CredentialCard, {
				key: service,
				provider: service,
				configured: state.credentials[service],
				feedback,
				onSaved: refreshState
			}))), (0, react.createElement)("form", {
				className: "zs-stack",
				onSubmit: save
			}, (0, react.createElement)("fieldset", {
				disabled: saving,
				className: "zs-stack"
			}, (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)(Check, {
				label: "启用语音生成",
				checked: speech.enabled,
				onChange: (enabled) => setDraft({
					...draft,
					speech: {
						...speech,
						enabled
					}
				})
			}), (0, react.createElement)(Field, {
				label: "默认语音服务",
				children: (0, react.createElement)("select", {
					value: speech.provider,
					onChange: (event) => setDraft({
						...draft,
						speech: {
							...speech,
							provider: event.target.value
						}
					})
				}, (0, react.createElement)("option", { value: "mimo" }, "MiMo"), (0, react.createElement)("option", { value: "minimax" }, "MiniMax"))
			}), (0, react.createElement)("div", { className: "zs-grid" }, (0, react.createElement)(NumberField, {
				label: "每条语音最多字数",
				value: speech.maxTextCharacters,
				min: 1,
				max: 5e3,
				onChange: (maxTextCharacters) => setDraft({
					...draft,
					speech: {
						...speech,
						maxTextCharacters
					}
				})
			}), (0, react.createElement)(NumberField, {
				label: "最长等待时间（秒）",
				value: speech.timeoutMs / 1e3,
				min: 1,
				max: 180,
				onChange: (seconds) => setDraft({
					...draft,
					speech: {
						...speech,
						timeoutMs: seconds * 1e3
					}
				})
			}))), (0, react.createElement)("div", { className: "zs-grid" }, (0, react.createElement)(ProviderEditor, {
				provider: "mimo",
				value: speech.mimo,
				onChange: (mimo) => setDraft({
					...draft,
					speech: {
						...speech,
						mimo
					}
				})
			}), (0, react.createElement)(ProviderEditor, {
				provider: "minimax",
				value: speech.minimax,
				onChange: (minimax) => setDraft({
					...draft,
					speech: {
						...speech,
						minimax
					}
				})
			})), (0, react.createElement)(SettingsFooter, {
				busy: saving,
				dirty
			}))), (0, react.createElement)("form", {
				className: "zs-card zs-stack",
				onSubmit: generate
			}, (0, react.createElement)("h3", null, "生成与试听"), (0, react.createElement)("p", { className: "zs-muted" }, "试听使用已保存的声音设置，可能产生所选服务的费用。这里只生成音频，不向 QQ 发送。"), (0, react.createElement)("fieldset", {
				disabled: task.busy,
				className: "zs-stack"
			}, (0, react.createElement)(Field, {
				label: "试听服务",
				children: (0, react.createElement)("select", {
					value: provider,
					onChange: (event) => setProvider(event.target.value)
				}, (0, react.createElement)("option", { value: "mimo" }, "MiMo"), (0, react.createElement)("option", { value: "minimax" }, "MiniMax"))
			}), (0, react.createElement)(Field, {
				label: "朗读内容",
				children: (0, react.createElement)("textarea", {
					value: text,
					required: true,
					rows: 4,
					maxLength: state.settings.speech.maxTextCharacters,
					placeholder: "写一段想听的话…",
					onChange: (event) => setText(event.target.value)
				})
			}), !state.settings.speech.enabled ? (0, react.createElement)("p", { className: "zs-muted" }, "请先启用语音生成并保存设置。") : !state.credentials[provider] ? (0, react.createElement)("p", { className: "zs-muted" }, `请先保存 ${PROVIDER_NAME[provider]} 的密钥。`) : null, (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				type: "submit",
				primary: true,
				disabled: task.busy || !text.trim() || !state.settings.speech.enabled || !state.credentials[provider]
			}, task.busy ? "正在生成，请稍候…" : "生成试听"), (0, react.createElement)("span", { className: "zs-muted" }, `${Array.from(text).length} / ${state.settings.speech.maxTextCharacters} 字`))), selected ? (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)("p", { className: "zs-muted" }, `${PROVIDER_NAME[selected.provider]} · ${selected.voice} · ${date(selected.createdAt)}`), (0, react.createElement)(AudioPreview, { item: selected })) : null), (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("div", { className: "zs-row" }, (0, react.createElement)("h3", { className: "zs-spacer" }, "所有对话的语音记录"), (0, react.createElement)(Button, {
				disabled: loading || task.busy,
				onClick: () => {
					task.run(async () => {
						await load();
						feedback("语音记录已刷新。");
					});
				}
			}, "刷新")), loading ? (0, react.createElement)(Empty, null, "正在读取语音记录…") : items.length ? (0, react.createElement)("div", null, items.map((item) => (0, react.createElement)("div", {
				className: "zs-record",
				key: item.fileName
			}, (0, react.createElement)("div", { className: "zs-record-head" }, (0, react.createElement)("div", null, (0, react.createElement)("p", { className: "zs-record-title" }, `${PROVIDER_NAME[item.provider]} · ${item.voice}`), (0, react.createElement)("p", { className: "zs-muted" }, `${date(item.createdAt)} · ${item.characters} 字 · ${Math.max(1, Math.round(item.bytes / 1024))} KB`)), (0, react.createElement)(Button, { onClick: () => setSelected(item) }, "试听"))))) : (0, react.createElement)(Empty, null, "还没有生成语音。")));
		}
		function LifePanel({ state, feedback, refreshState, draft, setDraft, save, saving, dirty }) {
			const life = draft.life;
			const task = useTask(feedback);
			const choices = (0, react.useMemo)(() => knownConversations(state).map((item) => [item.target, item]), [state.bindings, state.conversations]);
			const readTargets = life.readTargets ?? [];
			const known = new Set(choices.map(([target]) => target));
			const [extraTargets, setExtraTargets] = (0, react.useState)(() => life.targets.filter((target) => !known.has(target)).join("\n"));
			(0, react.useEffect)(() => {
				const selected = life.targets.filter((target) => !known.has(target)).join("\n");
				if (selected !== targetLines(extraTargets).filter((target) => !known.has(target)).join("\n")) setExtraTargets(selected);
			}, [
				life.targets,
				choices,
				extraTargets
			]);
			const update = (patch) => setDraft({
				...draft,
				life: {
					...life,
					...patch
				}
			});
			const manual = (path) => {
				task.run(async () => {
					await request(path, "POST", {});
					await refreshState();
					feedback(path === "/life/run" ? "活动请求已提交，可稍后刷新查看进展。" : "已提交停止请求。");
				});
			};
			const invalidTargets = targetLines(extraTargets).some((target) => !/^(c2c|group):[^\s:]+$/u.test(target));
			return (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("div", { className: "zs-row" }, (0, react.createElement)("h3", { className: "zs-spacer" }, "当前活动"), (0, react.createElement)("span", { className: "zs-badge" }, state.life.status === "running" ? "活动中" : state.life.status === "error" ? "需要查看" : state.settings.life.enabled ? "等待下次活动" : "未开启")), (0, react.createElement)("p", { className: "zs-body" }, state.life.summary || "尚无活动进展。"), (0, react.createElement)("p", { className: "zs-muted" }, state.life.nextWakeAt ? `下次活动：${date(state.life.nextWakeAt)} · ${state.life.nextWakeReason || "AI 已安排"}` : `下次活动：${state.life.nextWakeReason || "暂未安排，等待新事件或手动运行"}`), state.life.focus ? (0, react.createElement)("p", { className: "zs-muted" }, `当前关注：${state.life.focus}`) : null, (0, react.createElement)("p", { className: "zs-muted" }, `开始：${date(state.life.lastRunAt)}　结束：${date(state.life.lastFinishedAt)}`), state.life.error ? (0, react.createElement)("p", { className: "zs-danger" }, state.life.error) : null, (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				disabled: task.busy || !state.settings.life.enabled || state.life.status === "running",
				onClick: () => manual("/life/run")
			}, task.busy ? "处理中…" : "现在活动一次"), (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => manual("/life/stop")
			}, "停止当前活动"), (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => {
					task.run(refreshState);
				}
			}, "刷新进展"))), (0, react.createElement)("form", {
				className: "zs-stack",
				onSubmit: (event) => {
					event.preventDefault();
					if (invalidTargets) feedback("请检查手动填写的联系目标格式。", true);
					else save(event);
				}
			}, (0, react.createElement)("fieldset", {
				disabled: saving,
				className: "zs-stack"
			}, (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)(Check, {
				label: "开启自主生活",
				hint: "由 DSH 自动任务唤醒，可以探索、创作、整理，也可以选择休息。活动可能使用模型与已启用工具。",
				checked: life.enabled,
				onChange: (enabled) => update({ enabled })
			}), (0, react.createElement)(NumberField, {
				label: "每日自主活动上限",
				hint: "达到上限后休息；不影响正常 QQ 对话。",
				value: life.maxDailyRuns,
				min: 1,
				max: 1e3,
				onChange: (maxDailyRuns) => update({ maxDailyRuns })
			}), (0, react.createElement)(Field, {
				label: "兴趣与活动方向",
				children: (0, react.createElement)("textarea", {
					value: life.interests,
					rows: 5,
					maxLength: 4e3,
					placeholder: "希望关注的话题、想继续的小创作…",
					onChange: (event) => update({ interests: event.target.value })
				})
			}), (0, react.createElement)("div", { className: "zs-grid" }, (0, react.createElement)(NumberField, {
				label: "最短活动间隔（分钟）",
				hint: "仅作为使用下限，实际下次时间由 AI 决定。",
				value: life.minIntervalMinutes,
				min: 1,
				max: 1440,
				onChange: (minIntervalMinutes) => update({ minIntervalMinutes })
			}), (0, react.createElement)(Field, {
				label: "所在时区",
				children: (0, react.createElement)("input", {
					value: life.timeZone,
					required: true,
					maxLength: 100,
					placeholder: "Asia/Shanghai",
					onChange: (event) => update({ timeZone: event.target.value })
				})
			})), (0, react.createElement)("div", { className: "zs-grid" }, (0, react.createElement)(Field, {
				label: "安静时段开始",
				children: (0, react.createElement)("select", {
					value: life.quietStart,
					onChange: (event) => update({ quietStart: Number(event.target.value) })
				}, Array.from({ length: 24 }, (_, hour) => (0, react.createElement)("option", {
					key: hour,
					value: hour
				}, `${String(hour).padStart(2, "0")}:00`)))
			}), (0, react.createElement)(Field, {
				label: "安静时段结束",
				children: (0, react.createElement)("select", {
					value: life.quietEnd,
					onChange: (event) => update({ quietEnd: Number(event.target.value) })
				}, Array.from({ length: 24 }, (_, hour) => (0, react.createElement)("option", {
					key: hour,
					value: hour
				}, `${String(hour).padStart(2, "0")}:00`)))
			})), (0, react.createElement)("p", { className: "zs-muted" }, "开始和结束相同时不设置安静时段。")), (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, "可读取的聊天"), (0, react.createElement)("p", { className: "zs-muted" }, "自主活动可以按需读取这些聊天的近期对话，再决定探索什么或分享什么。读取名单与发送名单分别保存；未开启主动联系时，也能读取已选聊天。"), choices.length ? (0, react.createElement)("div", { className: "zs-targets" }, choices.map(([target, item]) => (0, react.createElement)(Check, {
				key: target,
				label: conversationName(item),
				hint: item.sessionId ? "已有会话记录" : "尚无会话记录；收到对话后才有内容可读",
				checked: readTargets.includes(target),
				onChange: (checked) => update({ readTargets: checked ? [.../* @__PURE__ */ new Set([...readTargets, target])] : readTargets.filter((value) => value !== target) })
			}))) : (0, react.createElement)("p", { className: "zs-muted" }, "请先在 QQ 与机器人聊天，或在目标群里 @ 它一次，再刷新目录。"), readTargets.filter((target) => !known.has(target)).map((target) => (0, react.createElement)(Check, {
				key: target,
				label: `已选目标 ${target}`,
				hint: "暂未出现在已知聊天中；可取消后重新选择。",
				checked: true,
				onChange: () => update({ readTargets: readTargets.filter((value) => value !== target) })
			}))), (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, "主动联系"), (0, react.createElement)(Check, {
				label: "允许主动联系 QQ",
				hint: "只向下面明确选择的目标发送；内部活动不会自动变成 QQ 消息。",
				checked: life.allowContact,
				onChange: (allowContact) => update({ allowContact })
			}), choices.length ? (0, react.createElement)("div", { className: "zs-targets" }, choices.map(([target, item]) => (0, react.createElement)(Check, {
				key: target,
				label: conversationName(item),
				hint: item.active ? void 0 : "目标当前不可用",
				checked: life.targets.includes(target),
				disabled: !item.active && !life.targets.includes(target),
				onChange: (checked) => update({ targets: checked ? [.../* @__PURE__ */ new Set([...life.targets, target])] : life.targets.filter((value) => value !== target) })
			}))) : (0, react.createElement)("p", { className: "zs-muted" }, "还没有已知的 QQ 会话。机器人收到消息后，会在这里出现。"), !choices.some(([, item]) => item.scope === "group") ? (0, react.createElement)("p", { className: "zs-muted" }, "还没发现群聊？在目标群里 @ 机器人一次，再刷新目录。") : null, (0, react.createElement)("details", null, (0, react.createElement)("summary", null, "手动添加联系目标"), (0, react.createElement)(Field, {
				label: "其他目标",
				hint: "每行一个。私聊填写 c2c:用户openid，群聊填写 group:群group_openid；群号不能替代 group_openid。",
				children: (0, react.createElement)("textarea", {
					value: extraTargets,
					rows: 3,
					maxLength: 12e3,
					placeholder: "c2c:用户openid\ngroup:群group_openid",
					onChange: (event) => {
						const value = event.target.value;
						setExtraTargets(value);
						update({ targets: [.../* @__PURE__ */ new Set([...life.targets.filter((target) => known.has(target)), ...targetLines(value)])] });
					}
				})
			}), invalidTargets ? (0, react.createElement)("p", { className: "zs-danger" }, "有目标格式不正确，请检查每行的开头和 ID。") : null), (0, react.createElement)("div", { className: "zs-grid" }, (0, react.createElement)(NumberField, {
				label: "每日主动联系上限",
				value: life.dailyContactLimit,
				min: 0,
				max: 100,
				onChange: (dailyContactLimit) => update({ dailyContactLimit })
			}), (0, react.createElement)(NumberField, {
				label: "同一目标联系间隔（分钟）",
				value: life.contactCooldownMinutes,
				min: 5,
				max: 10080,
				onChange: (contactCooldownMinutes) => update({ contactCooldownMinutes })
			})), (0, react.createElement)(Check, {
				label: "允许自主发送表情",
				checked: life.allowMemes,
				onChange: (allowMemes) => update({ allowMemes })
			}), (0, react.createElement)(Check, {
				label: "允许自主生成与发送语音",
				hint: "仍需启用语音服务并配置密钥。",
				checked: life.allowSpeech,
				onChange: (allowSpeech) => update({ allowSpeech })
			})), (0, react.createElement)(SettingsFooter, {
				busy: saving,
				dirty: dirty && !invalidTargets
			}))));
		}
		function SecurityPanel({ draft, setDraft, save, saving, dirty, state, feedback, refreshState }) {
			const task = useTask(feedback);
			const [selected, setSelected] = (0, react.useState)("");
			const candidates = (0, react.useMemo)(() => {
				const values = /* @__PURE__ */ new Map();
				for (const candidate of state.administratorCandidates ?? []) {
					const previous = values.get(candidate.senderId);
					if (!previous || candidate.lastSeenAt >= previous.lastSeenAt) values.set(candidate.senderId, {
						...candidate,
						name: candidate.name || previous?.name
					});
					else if (!previous.name && candidate.name) values.set(candidate.senderId, {
						...previous,
						name: candidate.name
					});
				}
				return [...values.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
			}, [state.administratorCandidates]);
			const administrators = draft.security.administrators;
			const available = candidates.filter((candidate) => candidate.observed && !administrators.includes(candidate.senderId));
			(0, react.useEffect)(() => {
				if (selected && !available.some((candidate) => candidate.senderId === selected)) setSelected("");
			}, [available, selected]);
			const shortId = (senderId) => senderId.length > 10 ? `…${senderId.slice(-8)}` : senderId;
			const userName = (candidate, senderId) => candidate?.name?.trim() || `${candidate?.observed ? "QQ 用户" : "已保存的管理员"} ${shortId(senderId)}`;
			const originName = (candidate) => candidate.scope === "group" ? state.conversations.find((item) => item.scope === "group" && item.peerId === candidate.peerId)?.alias || state.conversations.find((item) => item.scope === "group" && item.peerId === candidate.peerId)?.title || "群聊" : "私聊";
			const updateAdministrators = (values) => setDraft({
				...draft,
				security: {
					...draft.security,
					administrators: values
				}
			});
			return (0, react.createElement)("form", {
				className: "zs-stack",
				onSubmit: save
			}, (0, react.createElement)("fieldset", {
				disabled: saving,
				className: "zs-stack"
			}, (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("div", { className: "zs-row" }, (0, react.createElement)("h3", { className: "zs-spacer" }, "QQ 管理员"), (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => {
					task.run(async () => {
						await refreshState();
						feedback("可选用户已刷新。");
					});
				}
			}, task.busy ? "正在刷新…" : "刷新可选用户")), (0, react.createElement)("p", { className: "zs-muted" }, "从聊过天的用户中选择管理员，保存后生效。"), (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)(Field, {
				label: "添加管理员",
				children: (0, react.createElement)("select", {
					value: selected,
					disabled: task.busy || !available.length || administrators.length >= 100,
					onChange: (event) => setSelected(event.target.value)
				}, (0, react.createElement)("option", { value: "" }, "选择一位聊过天的用户"), available.map((candidate) => (0, react.createElement)("option", {
					key: candidate.senderId,
					value: candidate.senderId
				}, `${userName(candidate, candidate.senderId)} · ${originName(candidate)} · ${shortId(candidate.senderId)}`)))
			}), (0, react.createElement)("div", null, (0, react.createElement)(Button, {
				disabled: task.busy || !selected || administrators.length >= 100,
				onClick: () => {
					if (!available.some((candidate) => candidate.senderId === selected)) return;
					updateAdministrators([.../* @__PURE__ */ new Set([...administrators, selected])]);
					setSelected("");
				}
			}, "添加为管理员"))), !candidates.some((candidate) => candidate.observed) ? (0, react.createElement)("p", { className: "zs-muted" }, "还没有可选用户。请让对方先给机器人发一条消息，再刷新。") : !available.length ? (0, react.createElement)("p", { className: "zs-muted" }, "收到过消息的用户都已添加。") : null, administrators.length >= 100 ? (0, react.createElement)("p", { className: "zs-muted" }, "管理员名单已满，请先移除一位。") : null, administrators.length ? (0, react.createElement)("ul", {
				"aria-label": "当前管理员",
				style: {
					listStyle: "none",
					margin: 0,
					padding: 0
				}
			}, administrators.map((senderId) => {
				const candidate = candidates.find((item) => item.senderId === senderId);
				const label = userName(candidate, senderId);
				return (0, react.createElement)("li", {
					key: senderId,
					className: "zs-record zs-row"
				}, (0, react.createElement)("div", { className: "zs-spacer" }, (0, react.createElement)("p", { className: "zs-record-title" }, label), (0, react.createElement)("p", { className: "zs-muted zs-small" }, candidate?.observed ? originName(candidate) : "已保留原来的管理员设置")), (0, react.createElement)("button", {
					type: "button",
					className: "zs-button zs-danger",
					"aria-label": `移除管理员 ${label}`,
					disabled: task.busy,
					onClick: () => updateAdministrators(administrators.filter((value) => value !== senderId))
				}, "移除"));
			})) : (0, react.createElement)("p", { className: "zs-muted" }, "尚未设置管理员。")), (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, "群聊回复节奏"), (0, react.createElement)("p", { className: "zs-muted" }, "先收集连续消息，由 AI 决定是否回复。选择跳过时不会向 QQ 发送任何占位文字或内部进度。机器人只能接收 QQ 平台实际下发的消息。"), (0, react.createElement)("div", { className: "zs-grid" }, (0, react.createElement)(NumberField, {
				label: "收到最后一条后等待（毫秒）",
				value: draft.group.waitMs,
				min: 0,
				max: 1e4,
				onChange: (waitMs) => setDraft({
					...draft,
					group: {
						...draft.group,
						waitMs
					}
				})
			}), (0, react.createElement)(NumberField, {
				label: "连续消息最多等待（毫秒）",
				value: draft.group.maxWaitMs,
				min: 1e3,
				max: 3e4,
				onChange: (maxWaitMs) => setDraft({
					...draft,
					group: {
						...draft.group,
						maxWaitMs
					}
				})
			}))), (0, react.createElement)(SettingsFooter, {
				busy: saving || task.busy,
				dirty
			})));
		}
		function ServiceCredential({ provider, state, feedback, refreshState }) {
			const [secret, setSecret] = (0, react.useState)("");
			const task = useTask(feedback);
			const label = provider === "cloudflare" ? "Cloudflare API Token" : "ApiMart API Key";
			return (0, react.createElement)("form", {
				className: "zs-card zs-stack",
				onSubmit: (event) => {
					event.preventDefault();
					task.run(async () => {
						const value = secret;
						setSecret("");
						await request("/credential", "PUT", {
							provider,
							value
						});
						await refreshState();
						feedback(`${label} 已保存。`);
					});
				}
			}, (0, react.createElement)("div", { className: "zs-row" }, (0, react.createElement)("h3", { className: "zs-spacer" }, label), (0, react.createElement)("span", { className: "zs-badge" }, state.credentials[provider] ? "已配置" : "尚未配置")), (0, react.createElement)(Field, {
				label: "密钥",
				hint: provider === "cloudflare" ? "需要 Browser Rendering - Edit 权限。密钥只保存在 DSH 凭据服务，不会回显。" : "只保存在 DSH 凭据服务，不会加入聊天或浏览器草稿。",
				children: (0, react.createElement)("input", {
					type: "password",
					autoComplete: "off",
					value: secret,
					maxLength: 8192,
					disabled: task.busy,
					onChange: (event) => setSecret(event.target.value)
				})
			}), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				type: "submit",
				disabled: task.busy || !secret.trim()
			}, "保存密钥"), (0, react.createElement)(Button, {
				danger: true,
				disabled: task.busy || !state.credentials[provider],
				onClick: () => {
					task.run(async () => {
						setSecret("");
						await request("/credential", "PUT", {
							provider,
							value: null
						});
						await refreshState();
						feedback(`${label} 已移除。`);
					});
				}
			}, "移除密钥")));
		}
		function ServicesPanel({ state, feedback, refreshState, draft, setDraft, save, saving, dirty }) {
			const [browser, setBrowser] = (0, react.useState)();
			const task = useTask(feedback);
			const refreshBrowser = (0, react.useCallback)(async () => {
				const value = await request("/services/status");
				setBrowser(value.browser);
			}, []);
			(0, react.useEffect)(() => {
				refreshBrowser().catch((error) => feedback(message(error), true));
			}, [refreshBrowser, feedback]);
			const setBrowserSetting = (patch) => setDraft({
				...draft,
				browser: {
					...draft.browser,
					...patch
				}
			});
			const setImageSetting = (patch) => setDraft({
				...draft,
				images: {
					...draft.images,
					...patch
				}
			});
			const setDeploymentSetting = (patch) => setDraft({
				...draft,
				deployments: {
					...draft.deployments,
					...patch
				}
			});
			return (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)(ServiceCredential, {
				provider: "cloudflare",
				state,
				feedback,
				refreshState
			}), (0, react.createElement)(ServiceCredential, {
				provider: "apimart",
				state,
				feedback,
				refreshState
			}), (0, react.createElement)("form", {
				className: "zs-stack",
				onSubmit: save
			}, (0, react.createElement)("fieldset", {
				disabled: saving,
				className: "zs-stack"
			}, (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, "Cloudflare 云浏览器"), (0, react.createElement)(Check, {
				label: "启用云浏览器",
				hint: "通过 Playwright 浏览网页。任务结束、取消或报错时释放远端资源。",
				checked: draft.browser.enabled,
				onChange: (enabled) => setBrowserSetting({ enabled })
			}), (0, react.createElement)(Field, {
				label: "Cloudflare 账户 ID",
				children: (0, react.createElement)("input", {
					value: draft.browser.accountId,
					maxLength: 100,
					onChange: (event) => setBrowserSetting({ accountId: event.target.value.trim() })
				})
			}), (0, react.createElement)("div", { className: "zs-grid" }, (0, react.createElement)(NumberField, {
				label: "同时使用的浏览器上限",
				value: draft.browser.maxConcurrent,
				min: 1,
				max: 10,
				onChange: (maxConcurrent) => setBrowserSetting({ maxConcurrent })
			}), (0, react.createElement)(NumberField, {
				label: "单次任务最长秒数",
				value: draft.browser.maxSessionMs / 1e3,
				min: 1,
				max: 600,
				onChange: (value) => setBrowserSetting({ maxSessionMs: value * 1e3 })
			}), (0, react.createElement)(NumberField, {
				label: "空闲后释放（秒）",
				value: draft.browser.idleTimeoutMs / 1e3,
				min: 1,
				max: 60,
				onChange: (value) => setBrowserSetting({ idleTimeoutMs: value * 1e3 })
			}), (0, react.createElement)(NumberField, {
				label: "每日浏览器时间预算（分钟）",
				value: draft.browser.dailyBudgetMs / 6e4,
				min: 1,
				max: 1440,
				onChange: (value) => setBrowserSetting({ dailyBudgetMs: value * 6e4 })
			}))), (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, "ApiMart 图片生成"), (0, react.createElement)(Check, {
				label: "启用图片生成",
				checked: draft.images.enabled,
				onChange: (enabled) => setImageSetting({ enabled })
			}), (0, react.createElement)("p", { className: "zs-muted" }, "模型：gemini-nano-banana-2.1-ext。每次一张，默认 1K；不会自动切换其他计费模型。"), (0, react.createElement)("div", { className: "zs-grid" }, (0, react.createElement)(Field, {
				label: "默认画质",
				children: (0, react.createElement)("select", {
					value: draft.images.resolution,
					onChange: (event) => setImageSetting({ resolution: event.target.value })
				}, [
					"1K",
					"2K",
					"4K"
				].map((value) => (0, react.createElement)("option", {
					value,
					key: value
				}, value)))
			}), (0, react.createElement)(NumberField, {
				label: "每日提交图片上限",
				value: draft.images.dailyLimit,
				min: 1,
				max: 1e3,
				onChange: (dailyLimit) => setImageSetting({ dailyLimit })
			}))), (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, "临时网页部署"), (0, react.createElement)(Check, {
				label: "启用临时网页部署",
				hint: "无需登录正式 Cloudflare 账户。网页有 60 分钟认领窗口，未认领会自动删除。",
				checked: draft.deployments.enabled,
				onChange: (enabled) => setDeploymentSetting({ enabled })
			}), (0, react.createElement)(Check, {
				label: "我已阅读并接受 Cloudflare 服务条款与隐私政策",
				checked: draft.deployments.acceptedTerms,
				onChange: (acceptedTerms) => setDeploymentSetting({ acceptedTerms })
			}), (0, react.createElement)("p", { className: "zs-muted" }, (0, react.createElement)("a", {
				href: "https://www.cloudflare.com/terms/",
				target: "_blank",
				rel: "noreferrer noopener"
			}, "服务条款"), " · ", (0, react.createElement)("a", {
				href: "https://www.cloudflare.com/privacypolicy/",
				target: "_blank",
				rel: "noreferrer noopener"
			}, "隐私政策")), (0, react.createElement)(NumberField, {
				label: "同时保留的临时网页上限",
				value: draft.deployments.maxActive,
				min: 1,
				max: 20,
				onChange: (maxActive) => setDeploymentSetting({ maxActive })
			}), (0, react.createElement)("p", { className: "zs-muted" }, "预览链接可以分享。认领链接代表账户所有权，只在此管理页查看。到期重新部署将获得新地址。")), (0, react.createElement)(SettingsFooter, {
				busy: saving,
				dirty
			}))), (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, "浏览器资源"), (0, react.createElement)("p", { className: "zs-muted" }, browser ? `运行中：${browser.active}　今日已预留：${Math.ceil(browser.usedMsToday / 1e3)} 秒　待清理：${browser.cleanupPending}` : "正在读取使用情况…"), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => {
					task.run(refreshBrowser);
				}
			}, "刷新状态"), (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => {
					task.run(async () => {
						const value = await request("/browser/close", "POST", {});
						await refreshBrowser();
						feedback(value.closed ? "本插件当前浏览器已关闭。" : "关闭请求已执行，仍有远端会话待确认，请重试资源清理。", !value.closed);
					});
				}
			}, "关闭当前浏览器"), (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => {
					task.run(async () => {
						await request("/browser/recover", "POST", {});
						await refreshBrowser();
						feedback("已重试清理本插件遗留会话。");
					});
				}
			}, "重试资源清理"))), (0, react.createElement)(ImageStudio, {
				feedback,
				enabled: state.settings.images.enabled
			}), (0, react.createElement)(DeploymentList, { feedback }));
		}
		function ImageStudio({ feedback, enabled }) {
			const [items, setItems] = (0, react.useState)([]);
			const [prompt, setPrompt] = (0, react.useState)("");
			const [selfPortrait, setSelfPortrait] = (0, react.useState)(false);
			const [selected, setSelected] = (0, react.useState)();
			const task = useTask(feedback);
			const load = (0, react.useCallback)(async (signal) => {
				const value = await request("/images", "GET", void 0, signal);
				if (!signal?.aborted) setItems(value.items);
			}, []);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				setSelected(void 0);
				load(controller.signal).catch((error) => {
					if (!controller.signal.aborted) feedback(message(error), true);
				});
				return () => controller.abort();
			}, [load, feedback]);
			const media = useMedia(selected?.status === "completed" ? `${API}/images/media?${new URLSearchParams({ id: selected.id })}` : void 0);
			return (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("div", { className: "zs-row" }, (0, react.createElement)("h3", { className: "zs-spacer" }, "所有对话的图片记录"), (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => {
					task.run(load);
				}
			}, "刷新记录")), (0, react.createElement)("form", {
				className: "zs-stack",
				onSubmit: (event) => {
					event.preventDefault();
					task.run(async () => {
						const value = await request("/images", "POST", {
							prompt,
							selfPortrait
						});
						await load();
						setSelected(value.result);
						feedback(value.result.status === "completed" ? "图片已生成，管理页不会发送至QQ。" : "图片任务已保存，可稍后查询结果。");
					});
				}
			}, (0, react.createElement)(Field, {
				label: "画面描述",
				children: (0, react.createElement)("textarea", {
					value: prompt,
					rows: 3,
					maxLength: 8e3,
					disabled: task.busy,
					onChange: (event) => setPrompt(event.target.value)
				})
			}), (0, react.createElement)(Check, {
				label: "绘制自己的形象",
				hint: "自动附带已上传的人设原图。",
				checked: selfPortrait,
				disabled: task.busy,
				onChange: setSelfPortrait
			}), (0, react.createElement)("div", null, (0, react.createElement)(Button, {
				type: "submit",
				primary: true,
				disabled: task.busy || !enabled || !prompt.trim()
			}, task.busy ? "正在处理，请稍候…" : "生成一张图片"))), media.objectUrl ? (0, react.createElement)("div", { className: "zs-preview" }, (0, react.createElement)("img", {
				src: media.objectUrl,
				alt: selected?.selfPortrait ? "生成的自画像" : "生成图片",
				style: { maxWidth: "100%" }
			})) : null, items.length ? (0, react.createElement)("div", null, items.map((item) => (0, react.createElement)("div", {
				key: item.id,
				className: "zs-record"
			}, (0, react.createElement)("div", { className: "zs-record-head" }, (0, react.createElement)("span", null, `${date(item.createdAt)} · ${item.selfPortrait ? "自画像" : "图片"} · ${item.status === "completed" ? "已生成" : item.status === "failed" ? "生成失败" : item.status === "unknown" ? "提交结果待确认" : "处理中"}`), item.status === "completed" ? (0, react.createElement)(Button, { onClick: () => setSelected(item) }, "查看") : item.taskId ? (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => {
					task.run(async () => {
						const value = await request("/images/status", "POST", { id: item.id });
						await load();
						setSelected(value.result);
					});
				}
			}, "查询已有任务") : null), item.notice ? (0, react.createElement)("p", { className: "zs-muted" }, item.notice) : null))) : (0, react.createElement)("p", { className: "zs-muted" }, "还没有生成图片，所有对话的生成记录会显示在这里。"));
		}
		function DeploymentList({ feedback }) {
			const [items, setItems] = (0, react.useState)([]);
			const [claim, setClaim] = (0, react.useState)();
			const task = useTask(feedback);
			const load = (0, react.useCallback)(async (signal) => {
				const value = await request("/deployments", "GET", void 0, signal);
				if (!signal?.aborted) setItems(value.items);
			}, []);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				setClaim(void 0);
				load(controller.signal).catch((error) => {
					if (!controller.signal.aborted) feedback(message(error), true);
				});
				return () => controller.abort();
			}, [load, feedback]);
			return (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("div", { className: "zs-row" }, (0, react.createElement)("h3", { className: "zs-spacer" }, "临时网页"), (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => {
					task.run(load);
				}
			}, "刷新记录")), (0, react.createElement)("p", { className: "zs-muted" }, "所有对话的网页共用这份记录。在 QQ 中请 AI 制作网页并临时部署，完成后可以在这里查看预览和认领。"), items.length ? items.map((item) => (0, react.createElement)("div", {
				key: item.id,
				className: "zs-record zs-stack"
			}, (0, react.createElement)("p", null, `到期：${date(item.expiresAt)} · ${{
				ready: "可访问",
				preparing: "准备中",
				deploying: "部署中",
				unknown: "结果待确认",
				failed: "失败",
				expired: "临时授权已到期",
				deleted: "已移除"
			}[item.status] || item.status}`), item.previewUrl ? (0, react.createElement)("a", {
				href: item.previewUrl,
				target: "_blank",
				rel: "noreferrer noopener"
			}, "打开预览网页") : null, (0, react.createElement)("div", { className: "zs-actions" }, item.status === "unknown" ? (0, react.createElement)(Button, {
				disabled: task.busy,
				onClick: () => {
					task.run(async () => {
						await request("/deployments/status", "POST", { id: item.id });
						await load();
						feedback("已查询原部署，没有重新创建账户。");
					});
				}
			}, "查询部署结果") : null, (0, react.createElement)(Button, {
				disabled: task.busy || item.status !== "ready",
				onClick: () => {
					task.run(async () => {
						const value = await request(`/deployments/claim?${new URLSearchParams({ id: item.id })}`);
						setClaim({
							id: item.id,
							url: value.claimUrl
						});
					});
				}
			}, "查看认领链接"), (0, react.createElement)(Button, {
				danger: true,
				disabled: task.busy,
				onClick: () => {
					task.run(async () => {
						await request("/deployments", "DELETE", { id: item.id });
						setClaim(void 0);
						await load();
						feedback("已移除临时部署。");
					});
				}
			}, "移除")), claim?.id === item.id ? (0, react.createElement)("a", {
				href: claim.url,
				target: "_blank",
				rel: "noreferrer noopener"
			}, "前往 Cloudflare 认领（请勿分享此链接）") : null)) : (0, react.createElement)("p", { className: "zs-muted" }, "还没有临时网页，所有对话的网页记录会显示在这里。"));
		}
		function backupPasswordHeader(password) {
			let binary = "";
			for (const byte of new TextEncoder().encode(password)) binary += String.fromCharCode(byte);
			return btoa(binary);
		}
		function backupSize(bytes) {
			if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
			if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
			return `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
		}
		function saveBackupDownload(blob, fileName) {
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = fileName;
			anchor.style.display = "none";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1e3);
		}
		function BackupPanel({ feedback, onRestoreBusy }) {
			const [exportPassword, setExportPassword] = (0, react.useState)("");
			const [confirmation, setConfirmation] = (0, react.useState)("");
			const [includeCredentials, setIncludeCredentials] = (0, react.useState)(true);
			const [file, setFile] = (0, react.useState)();
			const [restorePassword, setRestorePassword] = (0, react.useState)("");
			const [prepared, setPrepared] = (0, react.useState)();
			const [restored, setRestored] = (0, react.useState)();
			const [status, setStatus] = (0, react.useState)();
			const [mode, setMode] = (0, react.useState)();
			const operation = (0, react.useRef)();
			const mounted = (0, react.useRef)(true);
			const previewGeneration = (0, react.useRef)(0);
			const fileInput = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				mounted.current = true;
				const controller = new AbortController();
				request("/backup/status", "GET", void 0, controller.signal).then((value) => {
					if (!controller.signal.aborted) setStatus(value);
				}).catch((error) => {
					if (!controller.signal.aborted) feedback(message(error), true);
				});
				return () => {
					mounted.current = false;
					controller.abort();
					operation.current?.controller?.abort();
				};
			}, [feedback]);
			const busy = mode !== void 0;
			const validPassword = (password) => password.length >= 8 && password.length <= 1024;
			const begin = (kind) => {
				if (operation.current) return;
				const current = {
					kind,
					...kind === "restore" || kind === "activate" ? {} : { controller: new AbortController() }
				};
				operation.current = current;
				setMode(kind);
				if (kind === "restore") onRestoreBusy(true);
				return current;
			};
			const finish = (current) => {
				if (operation.current === current) operation.current = void 0;
				if (mounted.current) setMode(void 0);
				if (current.kind === "restore") onRestoreBusy(false);
			};
			const invalidatePreview = () => {
				previewGeneration.current++;
				setPrepared(void 0);
				setRestored(void 0);
			};
			const cancel = () => {
				operation.current?.controller?.abort();
			};
			const exportBackup = (event) => {
				event.preventDefault();
				if (!validPassword(exportPassword)) {
					feedback("备份密码须为8至1024个字符。", true);
					return;
				}
				if (exportPassword !== confirmation) {
					feedback("两次输入的备份密码不一致。", true);
					return;
				}
				const current = begin("export");
				if (!current) return;
				(async () => {
					try {
						const response = await fetch(`${API}/backup/export`, {
							method: "POST",
							credentials: "same-origin",
							cache: "no-store",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								password: exportPassword,
								includeCredentials
							}),
							signal: current.controller.signal
						});
						if (!response.ok) throw await responseError(response);
						if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/octet-stream")) throw new Error("备份服务未返回有效的加密文件，请刷新后重试。");
						const blob = await response.blob();
						current.controller.signal.throwIfAborted();
						if (!blob.size) throw new Error("生成的备份为空，请重新导出。");
						saveBackupDownload(blob, `${PLUGIN_NAME}-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.zeta-backup`);
						if (mounted.current) {
							setExportPassword("");
							setConfirmation("");
							feedback("加密备份已生成并开始下载，请保存好备份文件和密码。");
						}
					} catch (error) {
						if (mounted.current) feedback(current.controller.signal.aborted ? "已取消生成备份。" : message(error), !current.controller.signal.aborted);
					} finally {
						finish(current);
					}
				})();
			};
			const downloadPlugin = () => {
				const current = begin("plugin");
				if (!current) return;
				(async () => {
					try {
						const response = await fetch(`${API}/backup/plugin`, {
							credentials: "same-origin",
							cache: "no-store",
							signal: current.controller.signal
						});
						if (!response.ok) throw await responseError(response);
						const blob = await response.blob();
						current.controller.signal.throwIfAborted();
						if (!blob.size) throw new Error("插件安装包为空，请刷新后重试。");
						saveBackupDownload(blob, `${PLUGIN_NAME}-plugin.tgz`);
						if (mounted.current) feedback("本版本插件已开始下载，不包含聊天、素材或密钥。请在新设备先安装DSH和此插件，再导入加密备份。");
					} catch (error) {
						if (mounted.current) feedback(current.controller.signal.aborted ? "已取消下载插件。" : message(error), !current.controller.signal.aborted);
					} finally {
						finish(current);
					}
				})();
			};
			const previewBackup = (event) => {
				event.preventDefault();
				if (!file || !file.size || file.size > 2 * 1024 ** 3) {
					feedback("请选择不超过2 GiB的非空备份文件。", true);
					return;
				}
				if (!validPassword(restorePassword)) {
					feedback("备份密码须为8至1024个字符。", true);
					return;
				}
				const current = begin("preview");
				if (!current) return;
				invalidatePreview();
				const generation = previewGeneration.current;
				(async () => {
					try {
						const response = await fetch(`${API}/backup/preview`, {
							method: "POST",
							credentials: "same-origin",
							cache: "no-store",
							headers: {
								"content-type": "application/octet-stream",
								"x-zeta-backup-password": backupPasswordHeader(restorePassword)
							},
							body: file,
							signal: current.controller.signal
						});
						if (!response.ok) throw await responseError(response);
						let value;
						try {
							value = await response.json();
						} catch {
							throw new Error("无法读取备份校验结果，请重新校验。");
						}
						current.controller.signal.throwIfAborted();
						if (!value || typeof value.token !== "string" || !value.token || !value.preview) throw new Error("备份校验结果不完整，请重新校验。");
						if (mounted.current && previewGeneration.current === generation) {
							setPrepared(value);
							feedback(value.preview.canRestore ? "备份已校验，请核对下方摘要后再决定是否恢复。" : "备份已校验，当前存在无法恢复的问题，请查看摘要。", !value.preview.canRestore);
						}
					} catch (error) {
						if (mounted.current) feedback(current.controller.signal.aborted ? "已取消上传与校验，当前数据未改变。" : message(error), !current.controller.signal.aborted);
					} finally {
						finish(current);
					}
				})();
			};
			const restoreBackup = () => {
				if (!prepared?.preview.canRestore) return;
				const token = prepared.token;
				const current = begin("restore");
				if (!current) return;
				setRestorePassword("");
				(async () => {
					try {
						const result = await request("/backup/restore", "POST", { token });
						if (result.restored !== true) throw new Error("恢复结果尚未确认，请查看DSH运行状态。");
						if (mounted.current) {
							setRestored(result);
							setPrepared(void 0);
							setFile(void 0);
							if (fileInput.current) fileInput.current.value = "";
							feedback("备份已恢复。QQ连接和自主生活均保持暂停；请按下方步骤启用新设备连接，再重新加载DSH。");
							try {
								const value = await request("/backup/status");
								if (mounted.current) setStatus(value);
							} catch {
								feedback("备份已恢复，暂时无法读取连接启用状态。请重新加载DSH后返回此页。", true);
							}
						}
					} catch (error) {
						if (mounted.current) {
							setPrepared(void 0);
							feedback(message(error), true);
						}
					} finally {
						finish(current);
					}
				})();
			};
			const activate = () => {
				if (!status?.canActivate) return;
				const current = begin("activate");
				if (!current) return;
				(async () => {
					try {
						if ((await request("/backup/activate", "POST", {})).restartRequired !== true) throw new Error("连接启用结果尚未确认，请刷新状态后重试。");
						if (mounted.current) {
							setStatus((previous) => ({
								...previous,
								canActivate: false,
								restartRequired: true
							}));
							feedback("迁移后的QQ连接已启用，请重新加载DSH使其生效。自主生活仍保持暂停，需单独手动开启。");
						}
					} catch (error) {
						if (mounted.current) feedback(message(error), true);
					} finally {
						finish(current);
					}
				})();
			};
			const preview = prepared?.preview;
			return (0, react.createElement)("div", { className: "zs-stack" }, (0, react.createElement)("div", { className: "zs-notice" }, "备份包含插件配置、记忆、表情、生成的语音、插件关联会话的完整DSH聊天记录，以及当前插件文件。导出使用已保存的数据，请先保存需要保留的设置修改。新电脑先安装DSH和下方的本版本插件，再导入加密备份。"), status?.pendingRestore ? (0, react.createElement)("div", {
				className: "zs-notice zs-error",
				role: "alert"
			}, "检测到尚未完成的恢复。QQ连接暂时保持暂停，请重新选择原备份并校验后继续恢复。") : status?.maintenance ? (0, react.createElement)("div", {
				className: "zs-notice",
				role: "status"
			}, "正在维护迁移数据，QQ连接暂时保持暂停。") : null, (0, react.createElement)("form", {
				className: "zs-card zs-stack",
				onSubmit: exportBackup
			}, (0, react.createElement)("h3", null, "导出加密备份"), (0, react.createElement)("fieldset", {
				disabled: busy,
				className: "zs-stack"
			}, (0, react.createElement)(Field, {
				label: "设置备份密码",
				hint: "至少8个字符。请单独保存密码；页面不会把密码写入草稿或浏览器存储。",
				children: (0, react.createElement)("input", {
					type: "password",
					autoComplete: "new-password",
					value: exportPassword,
					required: true,
					minLength: 8,
					maxLength: 1024,
					onChange: (event) => setExportPassword(event.target.value)
				})
			}), (0, react.createElement)(Field, {
				label: "再次输入备份密码",
				children: (0, react.createElement)("input", {
					type: "password",
					autoComplete: "new-password",
					value: confirmation,
					required: true,
					minLength: 8,
					maxLength: 1024,
					onChange: (event) => setConfirmation(event.target.value)
				})
			}), confirmation && confirmation !== exportPassword ? (0, react.createElement)("p", { className: "zs-danger" }, "两次输入的密码还不一致。") : null, (0, react.createElement)(Check, {
				label: "一并备份已配置的密钥",
				hint: "密钥会随备份加密保存，恢复时可迁移到新设备。",
				checked: includeCredentials,
				onChange: setIncludeCredentials
			}), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				type: "submit",
				primary: true,
				disabled: busy || !validPassword(exportPassword) || confirmation !== exportPassword
			}, mode === "export" ? "正在生成并下载…" : "导出加密备份"), (0, react.createElement)(Button, {
				disabled: busy,
				onClick: downloadPlugin
			}, mode === "plugin" ? "正在下载插件…" : "下载本版本插件")), (0, react.createElement)("p", { className: "zs-muted" }, "插件安装包只包含代码，不包含个人数据；完整加密备份中也保留了当前插件分发文件。")), mode === "export" ? (0, react.createElement)("div", {
				className: "zs-actions",
				role: "status"
			}, (0, react.createElement)("span", { className: "zs-muted zs-spacer" }, "正在整理并加密备份，较大的备份需要一些时间。"), (0, react.createElement)(Button, { onClick: cancel }, "取消导出")) : mode === "plugin" ? (0, react.createElement)(Button, { onClick: cancel }, "取消下载") : null), (0, react.createElement)("form", {
				className: "zs-card zs-stack",
				onSubmit: previewBackup
			}, (0, react.createElement)("h3", null, "选择备份并校验"), (0, react.createElement)("p", { className: "zs-muted" }, "选择文件后先检查内容与兼容性。校验不会恢复或覆盖当前数据。"), (0, react.createElement)("fieldset", {
				disabled: busy,
				className: "zs-stack"
			}, (0, react.createElement)(Field, {
				label: "备份文件",
				hint: "选择 .zeta-backup 文件，最大2 GiB。",
				children: (0, react.createElement)("input", {
					ref: fileInput,
					type: "file",
					accept: ".zeta-backup,application/octet-stream",
					onChange: (event) => {
						invalidatePreview();
						const selected = event.target.files?.[0];
						if (selected && (!selected.size || selected.size > 2 * 1024 ** 3)) {
							setFile(void 0);
							event.target.value = "";
							feedback("请选择不超过2 GiB的非空备份文件。", true);
							return;
						}
						setFile(selected);
					}
				})
			}), file ? (0, react.createElement)("p", { className: "zs-muted" }, `${file.name} · ${backupSize(file.size)}`) : null, (0, react.createElement)(Field, {
				label: "备份的恢复密码",
				children: (0, react.createElement)("input", {
					type: "password",
					autoComplete: "off",
					value: restorePassword,
					required: true,
					minLength: 8,
					maxLength: 1024,
					onChange: (event) => {
						setRestorePassword(event.target.value);
						invalidatePreview();
					}
				})
			}), (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				type: "submit",
				primary: true,
				disabled: busy || !file || !validPassword(restorePassword)
			}, mode === "preview" ? "正在上传并校验…" : "校验并查看摘要"))), mode === "preview" ? (0, react.createElement)("div", {
				className: "zs-actions",
				role: "status"
			}, (0, react.createElement)("span", { className: "zs-muted zs-spacer" }, "正在上传并检查备份，当前数据未改变。"), (0, react.createElement)(Button, { onClick: cancel }, "取消校验")) : null), preview ? (0, react.createElement)("div", { className: "zs-card zs-stack" }, (0, react.createElement)("h3", null, "恢复前核对"), (0, react.createElement)("p", { className: "zs-muted" }, `创建时间：${date(preview.createdAt)} · 插件 ${preview.pluginVersion} · DSH ${preview.dshVersion} · 备份格式 ${preview.formatVersion}`), (0, react.createElement)("div", { className: "zs-stats" }, [
				["聊天会话", preview.sessions],
				["会话目录", preview.conversations],
				["长期记忆", preview.memoryItems],
				["文件", preview.files]
			].map(([label, value]) => (0, react.createElement)("div", {
				className: "zs-card",
				key: label
			}, (0, react.createElement)("p", { className: "zs-muted" }, label), (0, react.createElement)("p", { className: "zs-stat" }, value)))), (0, react.createElement)("p", { className: "zs-muted" }, `备份内容：${backupSize(preview.bytes)} · ${preview.includesCredentials ? "包含加密保存的密钥" : "未包含密钥，恢复后需重新配置"}`), preview.warnings.length ? (0, react.createElement)("div", { className: "zs-notice" }, (0, react.createElement)("p", null, "恢复提示"), (0, react.createElement)("ul", null, preview.warnings.map((warning, index) => (0, react.createElement)("li", { key: index }, warning)))) : null, preview.conflicts.length ? (0, react.createElement)("div", {
				className: "zs-notice zs-error",
				role: "alert"
			}, (0, react.createElement)("p", null, "当前存在冲突，无法恢复"), (0, react.createElement)("ul", null, preview.conflicts.map((conflict, index) => (0, react.createElement)("li", { key: index }, conflict)))) : null, (0, react.createElement)("p", { className: "zs-body" }, "恢复将替换当前插件设置；已有聊天或素材发生冲突时会拒绝覆盖。恢复后QQ连接与自主生活均默认暂停，需确认旧设备已断开后启用新设备的QQ连接；自主生活需在重新加载DSH后单独手动开启。"), !preview.canRestore ? (0, react.createElement)("p", { className: "zs-danger" }, "该备份当前无法恢复，当前数据未改变。请处理上面的问题后重新校验。") : null, (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				danger: true,
				disabled: busy || !preview.canRestore,
				onClick: restoreBackup
			}, mode === "restore" ? "正在恢复，请保持页面打开…" : "恢复到本机"), mode === "restore" ? (0, react.createElement)(Button, { disabled: true }, "恢复期间无法取消") : null)) : null, restored || status?.canActivate || status?.restartRequired ? (0, react.createElement)("div", {
				className: "zs-card zs-stack",
				role: "status"
			}, (0, react.createElement)("h3", null, restored ? "恢复完成" : "迁移后的QQ连接"), restored ? (0, react.createElement)("p", null, `已恢复${restored.sessions}个聊天会话、${restored.files}个文件。重新加载DSH后可继续原来的聊天。`) : null, status?.canActivate ? (0, react.createElement)("p", { className: "zs-muted" }, "QQ连接当前保持暂停。请先关闭旧设备上的机器人连接，再启用本机，避免两台电脑同时连接同一个QQ机器人。") : (0, react.createElement)("p", { className: "zs-muted" }, "连接设置已保存，请重新加载DSH使其生效。"), (0, react.createElement)("p", { className: "zs-muted" }, "下方操作只启用迁移后的QQ连接；自主生活仍保持暂停，需在重新加载后查看设置并手动开启。"), status?.canActivate ? (0, react.createElement)("div", { className: "zs-actions" }, (0, react.createElement)(Button, {
				primary: true,
				disabled: busy || status.pendingRestore,
				onClick: activate
			}, mode === "activate" ? "正在保存连接设置…" : "启用迁移后的QQ连接")) : null, restored?.warnings.length ? (0, react.createElement)("ul", null, restored.warnings.map((warning, index) => (0, react.createElement)("li", { key: index }, warning))) : null) : null);
		}
		/** One browser-only settings surface. No host runtime imports or credential persistence. */
		function ZetaPanel() {
			useStyles();
			const [state, setState] = (0, react.useState)();
			const [draft, setDraftState] = (0, react.useState)();
			const [tab, setTab] = (0, react.useState)("overview");
			const draftValue = (0, react.useRef)();
			const draftBaseline = (0, react.useRef)();
			const setDraft = (0, react.useCallback)((value) => {
				const next = typeof value === "function" ? value(draftValue.current) : value;
				draftValue.current = next;
				setDraftState(next);
			}, []);
			const [notice, setNotice] = (0, react.useState)();
			const [loading, setLoading] = (0, react.useState)(true);
			const [saving, setSaving] = (0, react.useState)(false);
			const [restoreBusy, setRestoreBusy] = (0, react.useState)(false);
			const [identityBusy, setIdentityBusy] = (0, react.useState)(false);
			const identityOperation = (0, react.useRef)();
			const identityDraftRevision = (0, react.useRef)();
			const savePending = (0, react.useRef)(false);
			const tabPrefix = (0, react.useId)();
			const feedback = (0, react.useCallback)((text, error = false) => setNotice({
				text,
				error
			}), []);
			const refreshState = (0, react.useCallback)(async () => {
				const result = await request("/state");
				setState(result);
				setDraft((current) => {
					const baseline = draftBaseline.current ?? current ?? result.settings;
					const changes = settingsChanges(baseline, current ?? baseline);
					if (![
						"name",
						"persona",
						"habits"
					].some((key) => Object.hasOwn(changes, key))) identityDraftRevision.current = result.identity?.revision;
					draftBaseline.current = structuredClone(result.settings);
					return rebaseSettingsDraft(baseline, current ?? baseline, result.settings);
				});
			}, [setDraft]);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				request("/state", "GET", void 0, controller.signal).then((result) => {
					if (!controller.signal.aborted) {
						setState(result);
						draftBaseline.current = structuredClone(result.settings);
						setDraft(structuredClone(result.settings));
						identityDraftRevision.current = result.identity?.revision;
					}
				}).catch((error) => {
					if (!controller.signal.aborted) feedback(message(error), true);
				}).finally(() => {
					if (!controller.signal.aborted) setLoading(false);
				});
				return () => {
					controller.abort();
					identityOperation.current?.abort();
				};
			}, [feedback, setDraft]);
			const identityAction = (reset) => {
				if (identityOperation.current || savePending.current || restoreBusy) return;
				const controller = new AbortController();
				identityOperation.current = controller;
				setIdentityBusy(true);
				request(reset ? "/identity/reset" : "/identity", reset ? "POST" : "GET", reset ? { expected_revision: state?.identity?.revision ?? 0 } : void 0, controller.signal).then((value) => {
					if (controller.signal.aborted) return;
					const fields = {
						name: value.name,
						persona: value.persona,
						habits: [...value.habits]
					};
					identityDraftRevision.current = value.revision;
					if (draftBaseline.current) draftBaseline.current = {
						...draftBaseline.current,
						...fields
					};
					setDraft((current) => current ? {
						...current,
						...fields
					} : current);
					setState((current) => current ? {
						...current,
						settings: {
							...current.settings,
							...fields
						},
						identity: {
							revision: value.revision,
							updatedAt: value.updatedAt,
							history: value.history
						}
					} : current);
					feedback(reset ? "已恢复最新默认人设。其他功能的设置与未保存草稿保持不变。" : "已载入最新名字、人设和习惯。其他功能的草稿已保留。");
				}).catch((error) => {
					if (!controller.signal.aborted) feedback(message(error), true);
				}).finally(() => {
					if (identityOperation.current === controller) {
						identityOperation.current = void 0;
						setIdentityBusy(false);
					}
				});
			};
			const dirty = !!state && !!draft && JSON.stringify(state.settings) !== JSON.stringify(draft);
			const save = (event) => {
				event.preventDefault();
				if (!draft || savePending.current || restoreBusy || identityOperation.current) return;
				if ((draft.habits ?? []).length > 30 || (draft.habits ?? []).some((habit) => habit.length > 300)) {
					feedback("习惯最多30条，每条最多300字。", true);
					return;
				}
				const submitted = structuredClone(draft);
				savePending.current = true;
				setSaving(true);
				const changes = settingsChanges(draftBaseline.current ?? state?.settings, submitted);
				request("/settings", "PATCH", changes, void 0, ![
					"name",
					"persona",
					"habits"
				].some((key) => Object.hasOwn(changes, key)) || identityDraftRevision.current === void 0 ? void 0 : { "x-zeta-identity-revision": String(identityDraftRevision.current) }).then(async (result) => {
					draftBaseline.current = structuredClone(result.settings);
					if (result.identity) identityDraftRevision.current = result.identity.revision;
					setDraft((current) => rebaseSettingsDraft(submitted, current ?? submitted, result.settings));
					setState((current) => current ? {
						...current,
						settings: result.settings
					} : current);
					feedback(result.warning ? `设置已保存。${result.warning}` : "设置已保存，下次操作会使用新设置。");
					await refreshState();
				}).catch((error) => feedback(message(error), true)).finally(() => {
					savePending.current = false;
					setSaving(false);
				});
			};
			if (loading) return (0, react.createElement)("section", {
				className: "zeta-settings",
				"aria-label": `${PLUGIN_NAME}设置`
			}, (0, react.createElement)("p", {
				className: "zs-loading",
				role: "status"
			}, `正在读取 ${PLUGIN_NAME}…`));
			if (!state || !draft) return (0, react.createElement)("section", {
				className: "zeta-settings zs-stack",
				"aria-label": `${PLUGIN_NAME}设置`
			}, (0, react.createElement)("p", { role: "alert" }, notice?.text || "暂时无法读取设置。"), (0, react.createElement)(Button, { onClick: () => {
				setLoading(true);
				refreshState().catch((error) => feedback(message(error), true)).finally(() => setLoading(false));
			} }, "重新连接"));
			const editor = {
				draft,
				setDraft,
				save,
				saving: saving || identityBusy,
				dirty
			};
			let content;
			if (tab === "overview") content = (0, react.createElement)(Overview, {
				state,
				onNavigate: setTab
			});
			else if (tab === "persona") content = (0, react.createElement)(PersonaPanel, {
				...editor,
				feedback,
				identity: state.identity ?? {
					revision: 0,
					history: []
				},
				identityBusy,
				identityOutdated: state.identity?.revision !== identityDraftRevision.current,
				refreshIdentity: () => identityAction(false),
				resetIdentity: () => identityAction(true)
			});
			else if (tab === "conversations") content = (0, react.createElement)(ConversationsPanel, {
				...editor,
				state,
				feedback,
				refreshState
			});
			else if (tab === "memory") content = (0, react.createElement)(MemoryPanel, {
				...editor,
				feedback
			});
			else if (tab === "memes") content = (0, react.createElement)(MemePanel, { feedback });
			else if (tab === "speech") content = (0, react.createElement)(SpeechPanel, {
				...editor,
				feedback,
				state,
				refreshState
			});
			else if (tab === "security") content = (0, react.createElement)(SecurityPanel, {
				...editor,
				state,
				feedback,
				refreshState
			});
			else if (tab === "services") content = (0, react.createElement)(ServicesPanel, {
				...editor,
				state,
				feedback,
				refreshState
			});
			else if (tab === "backup") content = (0, react.createElement)(BackupPanel, {
				feedback,
				onRestoreBusy: setRestoreBusy
			});
			else content = (0, react.createElement)(LifePanel, {
				...editor,
				state,
				feedback,
				refreshState
			});
			return (0, react.createElement)("section", {
				className: "zeta-settings",
				"aria-label": `${PLUGIN_NAME}设置`
			}, (0, react.createElement)("div", { className: "zs-head" }, (0, react.createElement)("div", null, (0, react.createElement)("h2", null, PLUGIN_NAME), (0, react.createElement)("p", { className: "zs-muted" }, "一起聊天，也有自己的生活")), (0, react.createElement)("div", { className: "zs-actions" }, dirty ? (0, react.createElement)(Button, {
				disabled: saving || restoreBusy || identityBusy,
				onClick: () => {
					draftBaseline.current = structuredClone(state.settings);
					setDraft(structuredClone(state.settings));
					identityDraftRevision.current = state.identity?.revision;
					feedback("已恢复为最新读取的公共设置。");
				}
			}, "放弃未保存修改") : null, (0, react.createElement)(Button, {
				disabled: saving || restoreBusy || identityBusy,
				onClick: () => {
					refreshState().then(() => feedback("公共状态已刷新，未修改的设置已同步，本地修改已保留。")).catch((error) => feedback(message(error), true));
				}
			}, "刷新"))), notice ? (0, react.createElement)("div", {
				className: `zs-notice${notice.error ? " zs-error" : ""}`,
				role: notice.error ? "alert" : "status",
				"aria-live": "polite"
			}, notice.text) : null, (0, react.createElement)("div", {
				className: "zs-tabs",
				role: "tablist",
				"aria-label": `${PLUGIN_NAME}功能`
			}, TABS.map((item, index) => (0, react.createElement)("button", {
				key: item.id,
				id: `${tabPrefix}-${item.id}-tab`,
				type: "button",
				role: "tab",
				className: "zs-tab",
				disabled: restoreBusy,
				tabIndex: tab === item.id ? 0 : -1,
				"aria-selected": tab === item.id,
				"aria-controls": `${tabPrefix}-panel`,
				onClick: () => setTab(item.id),
				onKeyDown: (event) => {
					if (restoreBusy) return;
					const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : -1;
					if (next < 0) return;
					event.preventDefault();
					const selected = TABS[next];
					setTab(selected.id);
					document.getElementById(`${tabPrefix}-${selected.id}-tab`)?.focus();
				}
			}, item.label))), (0, react.createElement)("div", {
				id: `${tabPrefix}-panel`,
				role: "tabpanel",
				"aria-labelledby": `${tabPrefix}-${tab}-tab`
			}, content), (0, react.createElement)("p", {
				className: "zs-muted zs-small",
				style: { marginTop: 20 }
			}, `${PLUGIN_NAME} ${state.version}`));
		}
		// src/client/index.ts
		const name = "dsh-feiyu-zeta-client";
		const inject = [
			"slots",
			"sidebarRight",
			"sidebarRightTabs"
		];
		/** 侧栏 Tab 类型（ui-sidebar-right 契约的局部投影） */
		const TAB_KIND = "qqbot-bind";
		/** 席位注册 key（Tab 类型 id，席位按其分发；只需全局唯一，与包名解耦） */
		const TAB_ID = "im-qqbot/bind";
		/** 本插件包名（插件详情页按其匹配来源包，只在对应详情页渲染操作按钮） */
		const PACKAGE_NAME = "dsh-feiyu-zeta";
		/** 主面板 id（layout.selectPanel 导航目标；keyed main 席位按其分发） */
		const IM_MAIN_PANEL_ID = "im-qqbot";
		/** 绑定入口图标（QQ 机器人，跟随主题图标色变量） */
		function BindGuideIcon() {
			return (0, react.createElement)("svg", {
				width: 24,
				height: 24,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": true
			}, (0, react.createElement)("path", {
				d: "M9.50039 11.1504C9.96983 11.1504 10.3504 11.5309 10.3504 12.0004V14.0004C10.3504 14.4698 9.96983 14.8504 9.50039 14.8504C9.03095 14.8504 8.65039 14.4698 8.65039 14.0004V12.0004C8.65039 11.5309 9.03095 11.1504 9.50039 11.1504Z",
				fill: "var(------icon_primary, #1A1A1A)"
			}), (0, react.createElement)("path", {
				d: "M14.5004 11.1504C14.9698 11.1504 15.3504 11.5309 15.3504 12.0004V14.0004C15.3504 14.4698 14.9698 14.8504 14.5004 14.8504C14.0309 14.8504 13.6504 14.4698 13.6504 14.0004V12.0004C13.6504 11.5309 14.0309 11.1504 14.5004 11.1504Z",
				fill: "var(------icon_primary, #1A1A1A)"
			}), (0, react.createElement)("path", {
				fillRule: "evenodd",
				clipRule: "evenodd",
				d: "M12.8504 5.3109C13.5299 4.99138 14.0004 4.30063 14.0004 3.5C14.0004 2.39543 13.1049 1.5 12.0004 1.5C10.8958 1.5 10.0004 2.39543 10.0004 3.5C10.0004 4.30065 10.4708 4.99141 11.1504 5.31092V6.18851C6.38487 6.61795 2.65039 10.6231 2.65039 15.5004V17.0004C2.65039 19.679 4.82181 21.8504 7.50039 21.8504H16.5004C19.179 21.8504 21.3504 19.679 21.3504 17.0004V15.5004C21.3504 10.6231 17.6159 6.61795 12.8504 6.18851V5.3109ZM12.0004 7.85039C7.77541 7.85039 4.35039 11.2754 4.35039 15.5004V17.0004C4.35039 18.7401 5.76069 20.1504 7.50039 20.1504H16.5004C18.2401 20.1504 19.6504 18.7401 19.6504 17.0004V15.5004C19.6504 11.2754 16.2254 7.85039 12.0004 7.85039Z",
				fill: "var(------icon_primary, #1A1A1A)"
			}));
		}
		/** 设置页「QQ Bot」栏目：面板常驻展示绑定状态 */
		function QQBotSettingsSection() {
			return (0, react.createElement)("div", null, (0, react.createElement)(BindPanelBody), (0, react.createElement)(ConfigPanel), (0, react.createElement)(ZetaPanel));
		}
		/** 主面板页面：与设置栏目同一内容，包一层滚动留白容器（plugins.detail.actions 的跳转目标） */
		function QQBotPage() {
			return (0, react.createElement)("div", { className: "imqb-pluginPage" }, (0, react.createElement)("div", { className: "imqb-pluginPageContent" }, (0, react.createElement)(QQBotSettingsSection)));
		}
		/** 左侧栏入口图标（宿主传入 size：展开 18 / 收起 16；currentColor 跟随侧栏配色与选中态） */
		function QqBotSidebarIcon({ size = 16 }) {
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": true
			}, (0, react.createElement)("path", {
				d: QQ_BOT_LOGO_PATH,
				fill: "currentColor"
			}));
		}
		/** 插件详情「设置」按钮：仅在本包的 bundle / 组件行详情页渲染，其他插件不显示 */
		function OpenQqBotAction({ subject, packageName, onOpen }) {
			if (subject?.kind !== "bundle" && subject?.kind !== "row") return null;
			if (subject.pkg?.name !== packageName) return null;
			if (subject.kind === "row" && subject.row?.moduleName !== packageName) return null;
			return (0, react.createElement)("button", {
				type: "button",
				className: "imqb-pluginOpen",
				onClick: onOpen
			}, "设置");
		}
		function apply(ctx) {
			installPanelStyles();
			const tabs = ctx.sidebarRightTabs;
			const right = ctx.sidebarRight;
			const slots = ctx.slots;
			const disposers = [];
			if (slots !== void 0) disposers.push(slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "qqbot",
				order: 7,
				label: PACKAGE_NAME
			}, QQBotSettingsSection)));
			if (tabs !== void 0 && slots !== void 0) {
				disposers.push(tabs.register({
					id: TAB_ID,
					kind: TAB_KIND,
					title: () => `${PACKAGE_NAME} · QQ 绑定`,
					guide: [{
						id: "bind",
						order: 90,
						title: () => `${PACKAGE_NAME} · QQ 绑定`,
						description: () => `为 ${PACKAGE_NAME} 扫码或手动绑定 QQ`,
						icon: BindGuideIcon
					}]
				}));
				disposers.push(slots.inject("sidebar.right.pane.tab", () => slots.register({
					name: "sidebar.right.pane.tab",
					key: TAB_ID
				}, BindPanelBody)));
				disposers.push(watchAndPrompt(right));
			}
			const ctxInject = ctx.inject;
			if (typeof ctxInject === "function") ctxInject.call(ctx, ["layout"], (pageCtx) => {
				const pageSlots = pageCtx.slots;
				const layout = pageCtx.layout;
				if (pageSlots === void 0 || layout === void 0) return void 0;
				const stopMain = pageSlots.inject("main", () => pageSlots.register({
					name: "main",
					key: IM_MAIN_PANEL_ID
				}, QQBotPage));
				const stopActions = pageSlots.inject("plugins.detail.actions", () => pageSlots.register({
					name: "plugins.detail.actions",
					id: "im-qqbot-open",
					order: 20,
					inject: () => ({
						packageName: PACKAGE_NAME,
						onOpen: () => layout.selectPanel(IM_MAIN_PANEL_ID)
					})
				}, OpenQqBotAction));
				const stopSidebar = pageSlots.inject("sidebar.panellist", () => pageSlots.register({
					name: "sidebar.panellist",
					id: IM_MAIN_PANEL_ID,
					order: 10,
					label: PACKAGE_NAME
				}, QqBotSidebarIcon));
				return () => {
					stopActions();
					stopSidebar();
					stopMain();
				};
			});
			ctx.effect(() => () => {
				for (const dispose of disposers.reverse()) dispose();
			}, "dsh-feiyu-zeta-client.binding");
		}
		/**
		* 轮询绑定状态：待绑定时自动打开绑定页。
		*
		* - 页面隐藏时降频轮询（可见时立即恢复节拍）
		* - 404（已绑定/未安装）时退避到 30s，保持低成本常驻探测
		* - 每次页面加载至多打开一次（用户手动关闭后不打扰）；
		*   打开失败（如启动早期 Session surface 尚未挂载）不消费机会，
		*   由下一轮轮询（3s）自动重试
		*/
		function watchAndPrompt(right) {
			let stopped = false;
			let opened = right === void 0;
			let timer;
			const schedule = (ms) => {
				timer = setTimeout(() => {
					tick();
				}, ms);
			};
			const tick = async () => {
				if (stopped) return;
				if (typeof document !== "undefined" && document.visibilityState === "hidden") {
					schedule(5e3);
					return;
				}
				try {
					const res = await fetch(BIND_STATE_PATH, { cache: "no-store" });
					if (res.ok) {
						if ((await res.json()).phase === "waiting" && !opened && right !== void 0) try {
							right.openTab(TAB_KIND);
							opened = true;
						} catch (err) {
							console.error("[im-qqbot] 打开绑定页失败，稍后重试", err);
						}
						schedule(3e3);
						return;
					}
					schedule(3e4);
					return;
				} catch {}
				schedule(1e4);
			};
			tick();
			return () => {
				stopped = true;
				if (timer !== void 0) clearTimeout(timer);
			};
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map