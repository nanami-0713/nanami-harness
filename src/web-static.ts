/**
 * 静态文件服务（从 web-server 拆出，M·结构）。
 * 路径安全：resolve 规范化后按分隔符边界比较，防 ../ 穿越（WHATWG URL 会归一化
 * 点段，这里再兜一层 resolve 防御 —— 与 permissions.isInsideDir 同一套判定）。
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".webmanifest": "application/manifest+json",
	".png": "image/png",
	".ico": "image/x-icon",
};

const WEB_DIR = join(process.cwd(), "web");

export function serveStatic(pathname: string, res: ServerResponse): void {
	const rel = pathname === "/" ? "index.html" : pathname.slice(1);
	const file = resolve(WEB_DIR, rel);
	if ((file !== WEB_DIR && !file.startsWith(WEB_DIR + sep)) || !existsSync(file)) {
		res.writeHead(404).end("not found");
		return;
	}
	res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
	res.end(readFileSync(file));
}
