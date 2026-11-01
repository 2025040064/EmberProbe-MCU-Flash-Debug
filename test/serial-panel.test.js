"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { SerialPortMock } = require("serialport");
const { SerialPanel } = require("../src/services/serialPanel");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "serial-panel-"));
    try {
        SerialPortMock.binding.reset();
        SerialPortMock.binding.createPort("COM43", { echo: true });
        const sent = [],
            statuses = [];
        let receiver,
            onDispose,
            allowOpen = false;
        const webview = {
            cspSource: "https://example.invalid",
            html: "",
            asWebviewUri: (uri) => uri,
            postMessage: async (message) => sent.push(message),
            onDidReceiveMessage: (fn) => {
                receiver = fn;
                return { dispose() {} };
            }
        };
        const panel = {
            webview,
            reveal() {},
            onDidDispose: (fn) => {
                onDispose = fn;
            },
            dispose: () => onDispose()
        };
        const file = path.join(temp, "serial.log");
        const vscode = {
            Uri: { joinPath: (...parts) => parts.join("/") },
            ViewColumn: { Beside: 2 },
            window: {
                createWebviewPanel: () => panel,
                showSaveDialog: async () => ({ fsPath: file }),
                showErrorMessage() {}
            }
        };
        const owner = new SerialPanel({
            vscode,
            context: { extensionUri: "test" },
            t: (key) => key,
            canOpen: () => allowOpen,
            onStatus: (state) => statuses.push(state),
            SerialPort: SerialPortMock
        });
        owner.open();
        assert(webview.html.includes("Content-Security-Policy"));
        assert(webview.html.includes('id="log"'));
        await receiver({ type: "ready" });
        assert(sent.find((event) => event.type === "serialPorts").ports.some((port) => port.path === "COM43"));
        await receiver({
            type: "open",
            options: { path: "COM43", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none" }
        });
        assert.strictEqual(owner.monitor.snapshot().connected, false, "flash owns the port while opening is locked");
        assert(sent.some((event) => event.type === "serialError" && event.message === "esp.serialLocked"));
        allowOpen = true;
        await receiver({
            type: "open",
            options: { path: "COM43", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none" }
        });
        await receiver({ type: "send", options: { text: "hello", mode: "text", newline: "none" } });
        await delay(70);
        assert(sent.some((event) => event.type === "serialData"));
        await receiver({ type: "save", mode: "text" });
        assert((await fs.readFile(file, "utf8")).includes("hello"));
        panel.dispose();
        await owner.closing;
        assert.strictEqual(owner.monitor.snapshot().connected, false);
        assert(statuses.some((state) => state.connected));
        console.log("Serial panel lifecycle tests passed");
    } finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
