"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { parseKeilProject, readKeilTarget } = require("../src/services/keilProject");

const target = (name, device, output, driver = "STLink\\ST-LINKIII-KEIL_SWO.dll") => `
<Target><TargetName>${name}</TargetName><TargetOption><TargetCommonOption>
<Device>${device}</Device><Cpu>IRAM(0x20000000,0x5000) IROM(0x08000000,0x10000)</Cpu><OutputDirectory>.\\Objects\\</OutputDirectory>
<OutputName>${output}</OutputName><CreateExecutable>1</CreateExecutable>
</TargetCommonOption><DebugOption><TargetDlls><Driver>${driver}</Driver></TargetDlls></DebugOption>
</TargetOption></Target>`;
const xml = `<Project><Targets>${target("Debug &amp; Test", "STM32F103C8", "app")}${target("Other", "STM32G431CB", "other")}</Targets></Project>`;

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-keil-"));
    try {
        const file = path.join(root, "board.uvprojx");
        const parsed = parseKeilProject(xml, file);
        assert.strictEqual(parsed.length, 2);
        assert.strictEqual(parsed[0].name, "Debug & Test");
        assert.strictEqual(parsed[0].mcu, "stm32f1x.cfg");
        assert.strictEqual(parsed[1].mcu, "stm32g4x.cfg");
        assert.strictEqual(parsed[0].firmware, path.join(root, "Objects", "app.axf"));
        assert.strictEqual(parsed[0].debugger, "stlink.cfg");
        assert.deepStrictEqual(parsed[0].memoryRegions, [
            { name: "IRAM", origin: 0x20000000, capacity: 0x5000 },
            { name: "IROM", origin: 0x08000000, capacity: 0x10000 }
        ]);
        assert.strictEqual(
            parseKeilProject(
                `<Project><Targets>${target("DAP", "STM32F407VG", "x", "BIN\\UL2CM3.DLL")}</Targets></Project>`,
                file
            )[0].debugger,
            "cmsis-dap.cfg"
        );
        assert.strictEqual(
            parseKeilProject(
                `<Project><Targets>${target("JLink", "STM32F407VG", "x", "Segger\\JLink.dll")}</Targets></Project>`,
                file
            )[0].debugger,
            "jlink.cfg"
        );
        assert.throws(() => parseKeilProject("<!DOCTYPE Project><Project/>", file));
        assert.throws(() => parseKeilProject("<Project><Targets>", file));
        assert.throws(() => parseKeilProject("<Project/>", file));
        const missing = await readKeilTarget(parsed[0]);
        assert.strictEqual(missing.elf, "", "missing output never falls back to another target");
        assert.strictEqual(missing.firmwareStatus, "missing");
        await fs.mkdir(path.join(root, "Objects"));
        await fs.writeFile(parsed[0].firmware, "not an ELF");
        assert.strictEqual((await readKeilTarget(parsed[0])).firmwareStatus, "invalid");
        const header = Buffer.alloc(52);
        header.writeUInt32BE(0x7f454c46, 0);
        header[4] = header[5] = header[6] = 1;
        header.writeUInt16LE(40, 18);
        await fs.writeFile(parsed[0].firmware, header);
        assert.strictEqual((await readKeilTarget(parsed[0])).elf, parsed[0].firmware);
        header.writeUInt16LE(243, 18);
        await fs.writeFile(parsed[0].firmware, header);
        assert.strictEqual((await readKeilTarget(parsed[0])).firmwareStatus, "invalid");
        const unknown = parseKeilProject(
            `<Project><Targets>${target("Unknown", "GD32F303", "x")}</Targets></Project>`,
            file
        )[0];
        assert.strictEqual(unknown.mcu, "", "unknown devices must not inherit another target");
        // Run the actual import orchestration with only probe discovery replaced.
        const filename = path.resolve(__dirname, "../src/services/keilImport.js");
        const localRequire = createRequire(filename);
        let probes = { debugger: "", probeCandidates: [] };
        const moduleMock = { exports: {} };
        vm.runInThisContext(`(function(require,module){${await fs.readFile(filename, "utf8")}\n})`, { filename })(
            (name) => (name === "../autoDetect" ? { detectDebugger: async () => probes } : localRequire(name)),
            moduleMock
        );
        const { importKeilProject } = moduleMock.exports;
        await fs.writeFile(file, `<Project><Targets>${target("Debug", "STM32F103C8", "app")}</Targets></Project>`);
        header.writeUInt16LE(40, 18);
        await fs.writeFile(parsed[0].firmware, header);
        const workspace = new Map([["mcu.elfPath", "old.elf"]]);
        let editable = true;
        const notices = [];
        const provider = {
            _t: (key) => key,
            _assertConnectionEditable: () => {
                if (!editable) throw new Error("busy");
            },
            _context: { workspaceState: { update: async (key, value) => workspace.set(key, value) } },
            _availableOpenOcdScripts: async () => ({
                targets: ["stm32f1x.cfg"],
                interfaces: ["stlink.cfg", "cmsis-dap.cfg"]
            }),
            _refreshElfBindings: async () => {},
            updateView: async () => {},
            _refreshConnectedProbes: async () => {},
            _notices: { notify: (...args) => notices.push(args) }
        };
        let cancel = false;
        const vscode = {
            workspace: {
                isTrusted: true,
                getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
                findFiles: async (glob) =>
                    glob.includes("uvproj") ? [{ fsPath: file }] : [{ fsPath: path.join(root, "board.ioc") }]
            },
            window: {
                showOpenDialog: async () => (cancel ? undefined : [{ fsPath: file }]),
                showQuickPick: async () => undefined
            }
        };
        await importKeilProject(provider, vscode, { resource: { fsPath: path.join(root, "main.c") } });
        assert.strictEqual(workspace.get("mcu.elfPath"), parsed[0].firmware);
        assert.strictEqual(workspace.get("mcu.mcuCore"), "stm32f1x.cfg");
        assert.strictEqual(workspace.get("mcu.debugger"), "stlink.cfg");
        assert.strictEqual(workspace.get("mcu.iocPath"), path.join(root, "board.ioc"));
        cancel = true;
        const before = [...workspace];
        assert.strictEqual(await importKeilProject(provider, vscode, { browse: true }), null);
        assert.deepStrictEqual([...workspace], before, "cancel must preserve configuration");
        editable = false;
        await assert.rejects(importKeilProject(provider, vscode, { resource: { fsPath: file } }), /busy/);
        assert.deepStrictEqual([...workspace], before);
        editable = true;
        probes = { debugger: "cmsis-dap.cfg", probeCandidates: ["cmsis-dap.cfg"] };
        await fs.unlink(parsed[0].firmware);
        await importKeilProject(provider, vscode, { resource: { fsPath: file } });
        assert.strictEqual(workspace.get("mcu.elfPath"), "", "missing selected output clears stale firmware");
        assert.strictEqual(
            workspace.get("mcu.debugger"),
            "cmsis-dap.cfg",
            "connected probe wins over Keil driver hint"
        );
        assert.strictEqual(notices.at(-1)[2].key, "keil.buildFirst");
        await fs.writeFile(file, xml);
        const prior = [...workspace];
        assert.strictEqual(
            await importKeilProject(provider, vscode, { resource: { fsPath: file }, automatic: true }),
            false
        );
        assert.strictEqual(await importKeilProject(provider, vscode, { resource: { fsPath: file } }), null);
        assert.deepStrictEqual([...workspace], prior, "multiple targets require explicit selection");
        console.log("Keil import tests passed");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
