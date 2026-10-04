/**
 * Electron 桌面壳（可选）。加载 Web GUI 的同一宿主端口，仅此而已 ——
 * 与 ZCode 同构：Electron 是浏览器皮，Node 宿主进程才是 harness 本体。
 *
 * 使用：npm i -D electron && npx electron desktop/main.js
 * 前置：宿主已在别处运行（npm start）；端口可用 NANMI_PORT 覆盖。
 */
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");

const PORT = process.env.NANMI_PORT ?? 6110;

app.whenReady().then(() => {
	if (process.platform === "darwin" && app.dock) {
		app.dock.setIcon(join(__dirname, "..", "web", "icons", "icon-512.png"));
	}
	const win = new BrowserWindow({
		width: 1280,
		height: 820,
		title: "nanmi/harness",
		backgroundColor: "#0f1117",
		autoHideMenuBar: true,
	});
	win.loadURL(`http://127.0.0.1:${PORT}/`);
});

app.on("window-all-closed", () => app.quit());
