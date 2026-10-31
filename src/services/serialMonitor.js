"use strict";
const { StringDecoder } = require("string_decoder");

const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 2000;
const MAX_SEND_BYTES = 64 * 1024;

function encodeInput(text, mode, newline) {
    if (typeof text !== "string" || text.length > MAX_SEND_BYTES * 3) throw new Error("Invalid send content");
    let data;
    if (mode === "hex") {
        const compact = text.replace(/\s+/g, "");
        if (!/^(?:[0-9a-fA-F]{2})*$/.test(compact)) throw new Error("Invalid HEX bytes");
        data = Buffer.from(compact, "hex");
    } else if (mode === "text") data = Buffer.from(text, "utf8");
    else throw new Error("Invalid send mode");
    const endings = { none: "", lf: "\n", cr: "\r", crlf: "\r\n" };
    if (!Object.hasOwn(endings, newline)) throw new Error("Invalid line ending");
    data = Buffer.concat([data, Buffer.from(endings[newline])]);
    if (!data.length || data.length > MAX_SEND_BYTES) throw new Error("Send size must be 1–65536 bytes");
    return data;
}

function formatRecords(records, mode) {
    const decoders = { rx: new StringDecoder("utf8"), tx: new StringDecoder("utf8") };
    return records
        .map((record) => {
            const bytes = Buffer.from(record.data, "base64");
            const content =
                mode === "hex"
                    ? bytes.toString("hex").toUpperCase().match(/../g)?.join(" ") || ""
                    : decoders[record.direction].write(bytes);
            return `[${new Date(record.time).toLocaleTimeString()}] ${record.direction.toUpperCase()} ${content}`;
        })
        .join("\n");
}

class SerialMonitor {
    /** @param {{ SerialPort: any, onEvent?: Function }} options */
    constructor({ SerialPort, onEvent = () => {} }) {
        this.SerialPort = SerialPort;
        this.onEvent = onEvent;
        this.port = null;
        this.opening = false;
        this.openPromise = null;
        this.timer = null;
        this.sending = false;
        this.records = [];
        this.historyBytes = 0;
        this.droppedBytes = 0;
        this.rxBytes = 0;
        this.txBytes = 0;
        this.pending = [];
        this.pendingBytes = 0;
        this.flushTimer = null;
    }
    async list() {
        return (await this.SerialPort.list())
            .map((p) => ({
                path: String(p.path || ""),
                manufacturer: String(p.manufacturer || ""),
                serialNumber: String(p.serialNumber || "")
            }))
            .filter((p) => p.path);
    }
    snapshot() {
        return {
            connected: !!this.port?.isOpen,
            path: this.port?.path || "",
            opening: this.opening,
            repeating: !!this.timer,
            rxBytes: this.rxBytes,
            txBytes: this.txBytes,
            droppedBytes: this.droppedBytes,
            records: [...this.records]
        };
    }
    state() {
        this.onEvent({ type: "serialState", ...this.snapshot(), records: undefined });
    }
    record(direction, value) {
        const data = Buffer.from(value);
        if (!data.length) return;
        const record = { direction, time: Date.now(), data: data.toString("base64") };
        this.records.push(record);
        this.historyBytes += data.length;
        while (this.records.length > MAX_RECORDS || this.historyBytes > MAX_HISTORY_BYTES) {
            const removed = this.records.shift();
            const size = Buffer.byteLength(removed.data, "base64");
            this.historyBytes -= size;
            this.droppedBytes += size;
        }
        this.pending.push(record);
        this.pendingBytes += data.length;
        if (this.pendingBytes >= 64 * 1024) this.flush();
        else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 50);
    }
    flush() {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        if (!this.pending.length) return;
        const records = this.pending.splice(0);
        this.pendingBytes = 0;
        const { records: _history, ...status } = this.snapshot();
        this.onEvent({ type: "serialData", ...status, records });
    }
    async open(options) {
        if (this.port || this.opening) throw new Error("Serial port already open");
        const { path, baudRate, dataBits, stopBits, parity } = options || {};
        if (
            typeof path !== "string" ||
            !path ||
            path.length > 256 ||
            /[\r\n\0]/.test(path) ||
            !Number.isInteger(baudRate) ||
            baudRate < 50 ||
            baudRate > 4000000 ||
            ![5, 6, 7, 8].includes(dataBits) ||
            ![1, 2].includes(stopBits) ||
            !["none", "even", "odd", "mark", "space"].includes(parity)
        )
            throw new Error("Invalid serial settings");
        this.opening = true;
        this.state();
        let port;
        try {
            port = new this.SerialPort({ path, baudRate, dataBits, stopBits, parity, autoOpen: false });
        } catch (error) {
            this.opening = false;
            this.state();
            throw error;
        }
        this.port = port;
        port.on("data", (data) => {
            this.rxBytes += data.length;
            this.record("rx", data);
        });
        port.on("error", (error) => this.onEvent({ type: "serialError", message: error.message }));
        port.on("close", (error) => {
            this.stopRepeat();
            if (this.port === port) this.port = null;
            this.flush();
            this.state();
            if (error) this.onEvent({ type: "serialError", message: error.message });
        });
        try {
            this.openPromise = new Promise((resolve, reject) =>
                port.open((error) => (error ? reject(error) : resolve(undefined)))
            );
            await this.openPromise;
        } catch (error) {
            if (this.port === port) this.port = null;
            throw error;
        } finally {
            this.opening = false;
            this.openPromise = null;
            this.state();
        }
    }
    async close() {
        this.stopRepeat();
        if (this.openPromise) await this.openPromise.catch(() => {});
        const port = this.port;
        if (!port) return;
        if (port.isOpen)
            await new Promise((resolve, reject) => port.close((error) => (error ? reject(error) : resolve(undefined))));
        if (this.port === port) this.port = null;
        this.flush();
        this.state();
    }
    async send(options) {
        const data = encodeInput(options?.text, options?.mode, options?.newline);
        const port = this.port;
        if (!port?.isOpen) throw new Error("Serial port closed");
        if (this.sending) throw new Error("Serial write in progress");
        this.sending = true;
        try {
            await new Promise((resolve, reject) =>
                port.write(data, (error) => (error ? reject(error) : resolve(undefined)))
            );
            this.txBytes += data.length;
            this.record("tx", data);
        } finally {
            this.sending = false;
        }
    }
    startRepeat(options) {
        encodeInput(options?.text, options?.mode, options?.newline);
        if (!this.port?.isOpen) throw new Error("Serial port closed");
        if (!Number.isInteger(options.intervalMs) || options.intervalMs < 20 || options.intervalMs > 86400000)
            throw new Error("Interval must be 20–86400000 ms");
        this.stopRepeat();
        this.timer = setInterval(() => {
            if (!this.sending)
                this.send(options).catch((error) => {
                    this.stopRepeat();
                    this.onEvent({ type: "serialError", message: error.message });
                });
        }, options.intervalMs);
        this.state();
    }
    stopRepeat() {
        clearInterval(this.timer);
        this.timer = null;
        this.state();
    }
    clear() {
        this.records = [];
        this.historyBytes = this.droppedBytes = this.rxBytes = this.txBytes = 0;
        this.pending = [];
        this.pendingBytes = 0;
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.onEvent({ type: "serialClear" });
        this.state();
    }
}

module.exports = { SerialMonitor, encodeInput, formatRecords };
