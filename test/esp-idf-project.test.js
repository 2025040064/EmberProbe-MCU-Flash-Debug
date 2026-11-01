"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
    findEspIdfProjects,
    readEspIdfProject,
    importCurrentProject,
    restoreKeilConfiguration,
    runEspIdfAction
} = require("../src/services/espIdfProject");

(async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-idf-"));
    try {
        const project = path.join(parent, "idf project"),
            other = path.join(parent, "not-idf");
        await fs.mkdir(project, { recursive: true });
        await fs.mkdir(other, { recursive: true });
        await fs.writeFile(
            path.join(project, "CMakeLists.txt"),
            "include($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(blink)\n"
        );
        await fs.writeFile(path.join(project, "sdkconfig"), 'CONFIG_IDF_TARGET="esp32c6"\n');
        await fs.writeFile(path.join(other, "CMakeLists.txt"), "project(unrelated)\n");
        const folders = [{ uri: { fsPath: project } }];
        const files = [project, other].map((dir) => ({ fsPath: path.join(dir, "CMakeLists.txt") }));
        let installed = true,
            active = false,
            serialOpen = false,
            invoked = [];
        const vscode = {
            Uri: { file: (fsPath) => ({ fsPath }) },
            workspace: {
                isTrusted: true,
                workspaceFolders: folders,
                findFiles: async (glob) => (glob.includes("uvproj") ? [] : files),
                getWorkspaceFolder: (uri) => (uri.fsPath.startsWith(project) ? folders[0] : undefined)
            },
            extensions: {
                getExtension: () =>
                    installed
                        ? {
                              isActive: active,
                              activate: async () => {
                                  active = true;
                              }
                          }
                        : undefined
            },
            commands: {
                getCommands: async () => [
                    "espIdf.buildDevice",
                    "espIdf.flashDevice",
                    "espIdf.debug",
                    "espIdf.selectPort"
                ],
                executeCommand: async (name) => {
                    invoked.push(name);
                }
            }
        };
        const found = await findEspIdfProjects(vscode, { fsPath: path.join(project, "main.c") });
        assert.deepStrictEqual(found, [project]);
        assert.strictEqual((await readEspIdfProject(project)).target, "esp32c6");
        const values = new Map([
            ["mcu.elfPath", "previous-arm.elf"],
            ["mcu.mcuCore", "stm32f1x.cfg"],
            ["mcu.debugger", "stlink.cfg"]
        ]);
        const provider = {
            _t: (key) => key,
            _context: {
                workspaceState: { get: (key) => values.get(key), update: async (key, value) => values.set(key, value) }
            },
            _assertConnectionEditable: () => {},
            _refreshElfBindings: async () => {},
            updateView: async () => {},
            _notices: { notify: () => {} }
        };
        vscode.window = {};
        await importCurrentProject(provider, vscode, { fsPath: path.join(project, "main.c") });
        assert.strictEqual(values.get("mcu.projectType"), "espidf");
        assert.strictEqual(values.get("mcu.espIdfTarget"), "esp32c6");
        assert.strictEqual(values.get("mcu.elfPath"), "", "do not leave the ARM image active");
        assert.strictEqual(values.get("mcu.mcuCore"), "", "do not leave an unrelated target active");
        assert.strictEqual(values.get("mcu.previousKeilConfiguration")["mcu.elfPath"], "previous-arm.elf");
        await restoreKeilConfiguration(provider);
        assert.strictEqual(values.get("mcu.projectType"), "keil");
        assert.strictEqual(values.get("mcu.elfPath"), "previous-arm.elf", "switching back restores previous setup");
        assert.strictEqual(values.get("mcu.mcuCore"), "stm32f1x.cfg");
        await fs.writeFile(path.join(project, "sdkconfig"), 'CONFIG_IDF_TARGET="esp32h2"\n');
        assert.strictEqual((await readEspIdfProject(project)).target, "esp32h2");
        const options = { vscode, root: project, serialBusy: () => serialOpen, t: (key) => key };
        installed = false;
        await assert.rejects(runEspIdfAction({ ...options, action: "flash" }), /esp.extensionRequired/);
        assert.deepStrictEqual(invoked, []);
        installed = true;
        serialOpen = true;
        await assert.rejects(runEspIdfAction({ ...options, action: "flash" }), /esp.serialBusy/);
        assert.deepStrictEqual(invoked, []);
        serialOpen = false;
        active = false;
        vscode.extensions.getExtension = () => ({
            isActive: false,
            activate: async () => {
                serialOpen = true;
            }
        });
        await assert.rejects(runEspIdfAction({ ...options, action: "flash" }), /esp.serialBusy/);
        assert.deepStrictEqual(invoked, [], "a port opened during extension activation must stop flashing");
        serialOpen = false;
        vscode.extensions.getExtension = () => ({ isActive: true });
        vscode.debug = { activeDebugSession: {} };
        await assert.rejects(runEspIdfAction({ ...options, action: "flash" }), /esp.debugBusy/);
        assert.deepStrictEqual(invoked, []);
        vscode.debug.activeDebugSession = undefined;
        await runEspIdfAction({ ...options, action: "build" });
        await runEspIdfAction({ ...options, action: "flash" });
        assert.deepStrictEqual(invoked, ["espIdf.buildDevice", "espIdf.flashDevice"]);
        folders.push({ uri: { fsPath: other } });
        await assert.rejects(runEspIdfAction({ ...options, action: "flash" }), /esp.openProjectRoot/);
        assert.strictEqual(invoked.length, 2);
        vscode.workspace.isTrusted = false;
        await assert.rejects(runEspIdfAction({ ...options, action: "build" }), /keil.trustRequired/);
        console.log("ESP-IDF project detection and delegated action tests passed");
    } finally {
        await fs.rm(parent, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
