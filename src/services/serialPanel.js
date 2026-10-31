"use strict";
const fs = require("fs/promises");
const { SerialMonitor, formatRecords } = require("./serialMonitor");

const escape = (value) =>
    String(value).replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );

class SerialPanel {
    /** @param {{ vscode: any, context: any, t: Function, onStatus?: Function, SerialPort?: any }} options */
    constructor({ vscode, context, t, onStatus = () => {}, SerialPort }) {
        this.vscode = vscode;
        this.context = context;
        this.t = t;
        this.onStatus = onStatus;
        this.SerialPort = SerialPort;
        this.panel = null;
        this.monitor = null;
        this.closing = Promise.resolve();
    }
    open() {
        if (this.panel) {
            this.panel.reveal();
            return;
        }
        const v = this.vscode;
        if (!this.monitor) {
            // Delayed loading prevents a missing native binding from affecting unrelated extension features.
            const SerialPort = this.SerialPort || require("serialport").SerialPort;
            this.monitor = new SerialMonitor({
                SerialPort,
                onEvent: (event) => {
                    this.panel?.webview.postMessage(event);
                    if (event.type === "serialState") this.onStatus(event);
                }
            });
        }
        const panel = v.window.createWebviewPanel("emberprobe.serial", this.t("serial.title"), v.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [this.context.extensionUri]
        });
        this.panel = panel;
        const monitor = this.monitor;
        const script = panel.webview.asWebviewUri(
            v.Uri.joinPath(this.context.extensionUri, "src", "webview", "serial", "app.js")
        );
        const style = panel.webview.asWebviewUri(
            v.Uri.joinPath(this.context.extensionUri, "src", "webview", "serial", "app.css")
        );
        const tr = (key) => escape(this.t("serial." + key));
        const options = (list) =>
            list.map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join("");
        panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource};"><link rel="stylesheet" href="${style}"></head><body>
<main><header><div><h1>${tr("title")}</h1><p>${tr("description")}</p></div><span id="status" role="status">${tr("disconnected")}</span></header>
<section class="settings" aria-label="${tr("settings")}"><label>${tr("port")}<span class="port-row"><select id="port"></select><button id="refresh" type="button" title="${tr("refresh")}">↻</button></span></label>
<label>${tr("baud")}<input id="baud" type="number" min="50" max="4000000" value="115200" list="baudList"><datalist id="baudList"><option value="9600"><option value="19200"><option value="38400"><option value="57600"><option value="115200"><option value="230400"><option value="460800"><option value="921600"></datalist></label>
<label>${tr("dataBits")}<select id="dataBits">${options([
            ["8", "8"],
            ["7", "7"],
            ["6", "6"],
            ["5", "5"]
        ])}</select></label><label>${tr("parity")}<select id="parity">${options([
            ["none", this.t("serial.none")],
            ["even", this.t("serial.even")],
            ["odd", this.t("serial.odd")],
            ["mark", this.t("serial.mark")],
            ["space", this.t("serial.space")]
        ])}</select></label>
<label>${tr("stopBits")}<select id="stopBits">${options([
            ["1", "1"],
            ["2", "2"]
        ])}</select></label><button id="connect" class="primary" type="button">${tr("connect")}</button></section>
<div class="toolbar"><strong>${tr("receive")}</strong><label>${tr("display")} <select id="display"><option value="text">${tr("text")}</option><option value="hex">${tr("hex")}</option></select></label><span id="counters"></span><button id="clear" type="button">${tr("clear")}</button><button id="save" type="button">${tr("save")}</button></div>
<pre id="log" role="log" aria-label="${tr("receive")}" tabindex="0"></pre><div id="notice" role="status"></div>
<section class="send"><label for="input">${tr("send")}</label><textarea id="input" rows="3" spellcheck="false"></textarea><div class="toolbar"><label>${tr("format")} <select id="mode"><option value="text">${tr("text")}</option><option value="hex">${tr("hex")}</option></select></label><label>${tr("newline")} <select id="newline"><option value="none">${tr("none")}</option><option value="crlf">${tr("crlf")}</option><option value="lf">${tr("lf")}</option><option value="cr">${tr("cr")}</option></select></label><button id="send" class="primary" type="button">${tr("send")}</button><label>${tr("interval")} <input id="interval" type="number" min="20" max="86400000" value="1000"> ${tr("milliseconds")}</label><button id="repeat" type="button">${tr("startRepeat")}</button></div></section></main>
<script src="${script}"></script></body></html>`;
        const listener = panel.webview.onDidReceiveMessage(async (message) => {
            if (!message || typeof message.type !== "string") return;
            try {
                await this.closing;
                if (this.panel !== panel) return;
                switch (message.type) {
                    case "ready":
                        await panel.webview.postMessage({
                            type: "serialInit",
                            state: monitor.snapshot(),
                            labels: {
                                connected: this.t("serial.connected"),
                                disconnected: this.t("serial.disconnected"),
                                connect: this.t("serial.connect"),
                                disconnect: this.t("serial.disconnect"),
                                startRepeat: this.t("serial.startRepeat"),
                                stopRepeat: this.t("serial.stopRepeat"),
                                truncated: this.t("serial.truncated"),
                                received: this.t("serial.received"),
                                sent: this.t("serial.sent"),
                                byteUnit: this.t("serial.byteUnit")
                            }
                        });
                        await panel.webview.postMessage({ type: "serialPorts", ports: await monitor.list() });
                        break;
                    case "list":
                        await panel.webview.postMessage({ type: "serialPorts", ports: await monitor.list() });
                        break;
                    case "open":
                        await monitor.open(message.options);
                        break;
                    case "close":
                        await monitor.close();
                        break;
                    case "send":
                        await monitor.send(message.options);
                        break;
                    case "repeat":
                        monitor.startRepeat(message.options);
                        break;
                    case "stopRepeat":
                        monitor.stopRepeat();
                        break;
                    case "clear":
                        monitor.clear();
                        break;
                    case "save": {
                        const uri = await v.window.showSaveDialog({ filters: { Text: ["txt", "log"] } });
                        if (uri)
                            await fs.writeFile(
                                uri.fsPath,
                                formatRecords(monitor.snapshot().records, message.mode === "hex" ? "hex" : "text", {
                                    rx: this.t("serial.received"),
                                    tx: this.t("serial.sent")
                                }),
                                "utf8"
                            );
                        break;
                    }
                }
            } catch (error) {
                panel.webview.postMessage({ type: "serialError", message: error.message });
            }
        });
        panel.onDidDispose(() => {
            listener.dispose();
            if (this.panel === panel) this.panel = null;
            this.closing = monitor.close().catch((error) => {
                this.onStatus({ ...monitor.snapshot(), error: error.message });
                this.vscode.window.showErrorMessage(error.message);
            });
        });
    }
    async dispose() {
        this.panel?.dispose();
        await this.closing;
        await this.monitor?.close();
    }
}
module.exports = { SerialPanel };
