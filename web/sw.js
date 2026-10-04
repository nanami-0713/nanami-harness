/**
 * nanami/harness service worker —— 仅生命周期占位。
 *
 * 刻意**不注册 fetch 拦截**：会话事件流走 SSE（EventSource），经 SW 转发在某些
 * Chromium 版本会缓冲/断流；且本工具是本地宿主的皮，没有离线诉求。
 * 安装性（可安装为独立应用）由 manifest 满足，SW 只为兼容旧版安装判据存在。
 */
const CACHE = "nanami-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			await self.clients.claim();
			const keys = await caches.keys();
			await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
		})(),
	);
});
