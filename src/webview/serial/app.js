"use strict";
const api = acquireVsCodeApi();
const byId = (id) => document.getElementById(id);
const ids = [
    "port",
    "refresh",
    "baud",
    "dataBits",
    "parity",
    "stopBits",
    "connect",
    "display",
    "counters",
    "clear",
    "save",
    "log",
    "notice",
    "input",
    "mode",
    "newline",
    "send",
    "interval",
    "repeat",
    "status"
];
const ui = Object.fromEntries(ids.map((id) => [id, byId(id)]));
const saved = api.getState() || {};
for (const key of ["baud", "dataBits", "parity", "stopBits", "display", "mode", "newline", "interval"]) {
    if (saved[key] != null) ui[key].value = saved[key];
    ui[key].addEventListener("change", () => {
        saved[key] = ui[key].value;
        api.setState(saved);
    });
}
let labels = {},
    status = { connected: false },
    records = [],
    bytes = 0;
const maxBytes = 2 * 1024 * 1024;
const post = (type, extra = {}) => api.postMessage({ type, ...extra });
const sendOptions = () => ({ text: ui.input.value, mode: ui.mode.value, newline: ui.newline.value });
const decoder = () => ({ rx: new TextDecoder("utf-8"), tx: new TextDecoder("utf-8") });
let decoders = decoder();
function append(record) {
    const raw = atob(record.data);
    const data = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    const content =
        ui.display.value === "hex"
            ? Array.from(data, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ")
            : decoders[record.direction].decode(data, { stream: true });
    const line = document.createElement("span");
    line.className = record.direction;
    line.textContent = `[${new Date(record.time).toLocaleTimeString()}] ${record.direction.toUpperCase()} ${content}\n`;
    ui.log.append(line);
}
function render() {
    ui.log.replaceChildren();
    decoders = decoder();
    for (const record of records) append(record);
    ui.log.scrollTop = ui.log.scrollHeight;
}
function update(next) {
    status = { ...status, ...next };
    ui.status.textContent = status.connected ? `${labels.connected}: ${status.path}` : labels.disconnected || "";
    ui.status.classList.toggle("connected", !!status.connected);
    ui.connect.textContent = status.connected ? labels.disconnect : labels.connect;
    ui.connect.disabled = !!status.opening;
    for (const key of ["port", "baud", "dataBits", "stopBits", "parity", "refresh"])
        ui[key].disabled = !!status.connected || !!status.opening;
    ui.send.disabled = ui.repeat.disabled = !status.connected;
    ui.repeat.textContent = status.repeating ? labels.stopRepeat : labels.startRepeat;
    ui.counters.textContent = `RX ${status.rxBytes || 0} B · TX ${status.txBytes || 0} B`;
    if (status.droppedBytes) ui.notice.textContent = `${labels.truncated}: ${status.droppedBytes} B`;
}
ui.refresh.onclick = () => post("list");
ui.connect.onclick = () =>
    status.connected
        ? post("close")
        : post("open", {
              options: {
                  path: ui.port.value,
                  baudRate: Number(ui.baud.value),
                  dataBits: Number(ui.dataBits.value),
                  stopBits: Number(ui.stopBits.value),
                  parity: ui.parity.value
              }
          });
ui.send.onclick = () => post("send", { options: sendOptions() });
ui.repeat.onclick = () =>
    status.repeating
        ? post("stopRepeat")
        : post("repeat", { options: { ...sendOptions(), intervalMs: Number(ui.interval.value) } });
ui.clear.onclick = () => post("clear");
ui.save.onclick = () => post("save", { mode: ui.display.value });
ui.display.onchange = render;
ui.port.onchange = () => {
    saved.port = ui.port.value;
    api.setState(saved);
};
window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "serialInit") {
        labels = m.labels;
        records = m.state.records || [];
        bytes = records.reduce((n, r) => n + atob(r.data).length, 0);
        update(m.state);
        render();
    } else if (m.type === "serialState") update(m);
    else if (m.type === "serialData") {
        for (const record of m.records) {
            records.push(record);
            bytes += atob(record.data).length;
            append(record);
        }
        while (records.length > 2000 || bytes > maxBytes) {
            bytes -= atob(records.shift().data).length;
            ui.log.firstChild?.remove();
        }
        ui.log.scrollTop = ui.log.scrollHeight;
        update(m);
    } else if (m.type === "serialPorts") {
        const previous = ui.port.value || saved.port;
        ui.port.replaceChildren();
        for (const port of m.ports) {
            const option = document.createElement("option");
            option.value = port.path;
            option.textContent = [port.path, port.manufacturer].filter(Boolean).join(" · ");
            ui.port.append(option);
        }
        if (m.ports.some((port) => port.path === previous)) ui.port.value = previous;
    } else if (m.type === "serialClear") {
        records = [];
        bytes = 0;
        ui.notice.textContent = "";
        render();
    } else if (m.type === "serialError") ui.notice.textContent = m.message;
});
post("ready");
