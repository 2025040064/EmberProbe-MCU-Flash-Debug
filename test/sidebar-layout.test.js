"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { FakeClock } = require("./helpers/fake-clock");
const { getModernWebviewContent } = require("../src/modernView");

const configured = { elf: "app.elf", debugger: "interface/stlink.cfg", mcu: "stm32f4x.cfg" };

// MCU configuration is a folded card above flash/debug whose row names the chip family and probe.
let view = render(getModernWebviewContent(configured, "zh"));
try {
    view.assertHealthy();
    const doc = view.document;
    const config = doc.getElementById("mcuConfigSection");
    assert.ok(config.nextElementSibling.classList.contains("serial-entry"));
    assert.strictEqual(config.nextElementSibling.nextElementSibling.id, "flashDebugSection");
    assert.strictEqual(config.previousElementSibling.id, "keilImportSection");
    assert.strictEqual(doc.getElementById("keilImportSection").previousElementSibling.id, "noticeGlobal");
    assert.strictEqual(doc.querySelector("#keilImportSection button").dataset.command, "mcu-vscode.readCurrentKeil");
    assert.ok(config.querySelector('[data-command="mcu-vscode.importKeil"]'), "manual import is inside configuration");
    assert.ok(!doc.querySelector('#keilImportSection [data-command="mcu-vscode.importKeil"]'));
    assert.ok(!doc.getElementById("noticeConfig").closest("details"), "import errors remain visible while folded");
    assert.strictEqual(config.open, false, "the configuration card is folded on first use");
    const summary = doc.getElementById("mcuConfigSummary");
    assert.strictEqual(summary.textContent, "STM32F4x · ST-Link");
    assert.strictEqual(config.querySelector("summary .config-title").textContent, "手动导入与配置");
    view.send({ type: "setLang", lang: "en" });
    assert.strictEqual(config.querySelector("summary .config-title").textContent, "Manual import and configuration");
    assert.strictEqual(summary.textContent, "STM32F4x · ST-Link", "a language change keeps the summary");
    view.send({ type: "debuggerConfig", debugger: "jlink.cfg" });
    assert.strictEqual(summary.textContent, "STM32F4x · J-Link");
    view.send({ type: "debuggerConfig", debugger: "" });
    assert.strictEqual(summary.textContent, "", "an incomplete configuration names nothing");

    // Chip information, Agent Skills and MCP share one collapsible section.
    const other = doc.getElementById("deviceToolsSection");
    assert.strictEqual(doc.getElementById("skillStatus").closest("#deviceToolsSection"), other);
    assert.ok(other.contains(doc.getElementById("chipInfoSection")));
    const mcp = other.querySelector('[data-command="mcu-vscode.installMcpServer"]');
    assert.ok(mcp, "Device tools offers the MCP installer");
    assert.strictEqual(doc.querySelector(".skill-row, .skill-tree"), null);
    mcp.click();
    assert.deepStrictEqual(view.messages.at(-1), { type: "executeCommand", cmd: "mcu-vscode.installMcpServer" });
    assert.strictEqual(config.open, false, "installing the MCP server needs no MCU configuration");

    // An operation that needs the configuration opens the card while it is incomplete.
    doc.querySelector('[data-command="mcu-vscode.download"]').click();
    assert.strictEqual(config.open, true);
    assert.strictEqual(view.getState().sections.mcuConfigSection, true);
} finally {
    view.close();
}

// A complete configuration stays folded when an operation runs.
view = render(getModernWebviewContent(configured, "en"));
try {
    view.document.querySelector('[data-command="mcu-vscode.download"]').click();
    assert.strictEqual(view.document.getElementById("mcuConfigSection").open, false);
} finally {
    view.close();
}

// The status line and the flash notices share one box; a notice takes the status line's place.
view = render(getModernWebviewContent({}, "en"));
try {
    const doc = view.document;
    const box = doc.querySelector("#flashDebugSection > .flash-notice-box");
    assert.ok(box.contains(doc.getElementById("statusText")));
    assert.ok(box.contains(doc.getElementById("noticeFlash")));
    view.send({ type: "initSuccess" });
    assert.strictEqual(doc.getElementById("statusText").textContent, "Extension service ready");
    assert.strictEqual(doc.getElementById("flashStatus").dataset.state, "ready");
    view.send({ type: "notice", area: "flash", id: "mcu-vscode.download", notice: { level: "info", busy: true } });
    assert.strictEqual(doc.getElementById("noticeFlash").hidden, false);
    const progress = doc.getElementById("flashProgress");
    assert.strictEqual(progress.dataset.state, "busy");
    assert.strictEqual(progress.hasAttribute("aria-valuenow"), false, "unknown progress must not invent a percentage");
    view.send({ type: "notice", area: "flash", id: "mcu-vscode.download", notice: { level: "success" } });
    assert.strictEqual(progress.dataset.state, "success");
    view.send({ type: "notice", area: "flash", id: "mcu-vscode.download", notice: { level: "error" } });
    assert.strictEqual(progress.dataset.state, "error");
    view.send({ type: "noticeClear", area: "flash", id: "mcu-vscode.download" });
    assert.strictEqual(doc.getElementById("noticeFlash").hidden, true);
} finally {
    view.close();
}
console.log("Sidebar layout: Keil import, serial entry, memory and collapsible device tools");

view = render(
    getModernWebviewContent({ projectType: "espidf", espIdfProject: "C:/demo/blink", espIdfTarget: "esp32c6" }, "zh")
);
try {
    const doc = view.document;
    assert.ok(doc.body.classList.contains("esp-idf-mode"));
    assert.match(doc.querySelector(".esp-project").textContent, /blink.*esp32c6/s);
    assert.ok(doc.querySelector('[data-command="mcu-vscode.espBuild"]'));
    assert.ok(doc.querySelector('[data-command="mcu-vscode.espPort"]'));
    assert.ok(doc.querySelector('[data-command="mcu-vscode.restoreKeil"]'));
    assert.strictEqual(doc.querySelector('[data-command="mcu-vscode.debug"]').textContent, "ESP-IDF 调试");
    doc.querySelector('[data-command="mcu-vscode.espBuild"]').click();
    assert.strictEqual(
        doc.getElementById("mcuConfigSection").open,
        false,
        "ESP actions do not reveal ARM configuration"
    );
    assert.deepStrictEqual(view.messages.at(-1), { type: "executeCommand", cmd: "mcu-vscode.espBuild" });
    view.send({ type: "notice", area: "flash", id: "mcu-vscode.download", notice: { level: "info", busy: true } });
    view.send({
        type: "notice",
        area: "flash",
        id: "mcu-vscode.download",
        notice: { level: "info", key: "esp.completed" }
    });
    assert.strictEqual(doc.getElementById("flashProgress").dataset.state, "idle", "delegation must not imply success");
    view.assertHealthy();
} finally {
    view.close();
}

(async () => {
    const clock = new FakeClock();
    const panel = render(getModernWebviewContent(configured, "zh"), {}, { clock });
    try {
        const progress = panel.document.getElementById("flashProgress");
        const label = panel.document.getElementById("flashButtonLabel");
        const send = (notice) => panel.send({ type: "notice", area: "flash", id: "mcu-vscode.download", notice });
        assert.ok(panel.document.querySelector(".flash-check"), "successful flash has a check icon");
        send({ level: "info", busy: true });
        assert.strictEqual(label.textContent, "烧录中");
        send({ level: "success" });
        assert.strictEqual(progress.dataset.state, "success");
        assert.strictEqual(label.textContent, "烧录完成");
        await clock.advance(3500);
        assert.strictEqual(progress.dataset.state, "idle", "success returns to the original button");
        assert.strictEqual(label.textContent, "烧录");
        send({ level: "success" });
        await clock.advance(1000);
        send({ level: "info", busy: true });
        await clock.advance(3500);
        assert.strictEqual(progress.dataset.state, "busy", "an earlier success timer cannot interrupt a new flash");
        send({ level: "error" });
        assert.strictEqual(progress.dataset.state, "error");
        assert.strictEqual(label.textContent, "烧录");
        panel.assertHealthy();
    } finally {
        panel.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
