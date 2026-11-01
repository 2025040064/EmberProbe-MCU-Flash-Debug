"use strict";
const fs = require("fs/promises");
const path = require("path");
const { inside, findKeilProjects } = require("./keilProject");
const { importKeilProject } = require("./keilImport");

const MAX_PROJECT_BYTES = 256 * 1024;
const ACTIONS = Object.freeze({
    build: "espIdf.buildDevice",
    flash: "espIdf.flashDevice",
    debug: "espIdf.debug",
    port: "espIdf.selectPort"
});
const KEIL_CONFIGURATION_KEYS = Object.freeze([
    "mcu.elfPath",
    "mcu.mcuCore",
    "mcu.debugger",
    "mcu.iocPath",
    "mcu.keilProject",
    "mcu.keilTarget"
]);

async function readSmall(file) {
    try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES) return "";
        return await fs.readFile(file, "utf8");
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return "";
        throw error;
    }
}

async function readEspIdfProject(root) {
    const cmake = await readSmall(path.join(root, "CMakeLists.txt"));
    // An ordinary CMake or PlatformIO project is not enough to identify an ESP-IDF project.
    if (
        !/include\s*\(\s*["']?\s*\$(?:ENV\{IDF_PATH\}|\{IDF_PATH\})[/\\]tools[/\\]cmake[/\\]project\.cmake\s*["']?\s*\)/i.test(
            cmake
        )
    )
        return null;
    const config =
        (await readSmall(path.join(root, "sdkconfig"))) || (await readSmall(path.join(root, "sdkconfig.defaults")));
    const match = config.match(/^\s*CONFIG_IDF_TARGET\s*=\s*["']?(esp32[a-z0-9]*)["']?\s*$/im);
    return { root, name: path.basename(root), target: match ? match[1].toLowerCase() : "" };
}

async function findEspIdfProjects(vscode, resource) {
    const files = await vscode.workspace.findFiles(
        "**/CMakeLists.txt",
        "{**/node_modules/**,**/.git/**,**/build/**,**/managed_components/**,**/.pio/**}",
        150
    );
    const folder = resource && vscode.workspace.getWorkspaceFolder?.(resource);
    const found = [];
    for (const uri of files) {
        const root = path.dirname(uri.fsPath);
        if (folder && !inside(uri.fsPath, folder.uri.fsPath)) continue;
        if (!vscode.workspace.getWorkspaceFolder?.(uri)) continue;
        if (await readEspIdfProject(root)) found.push(root);
    }
    let candidates = [...new Set(found)].sort();
    if (resource && folder) {
        let directory = path.dirname(resource.fsPath);
        while (inside(directory, folder.uri.fsPath) || directory === folder.uri.fsPath) {
            const nearby = candidates.filter((candidate) => candidate === directory || inside(candidate, directory));
            if (nearby.length) return nearby;
            const parent = path.dirname(directory);
            if (parent === directory) break;
            directory = parent;
        }
    }
    return candidates;
}

function fail(t, key) {
    return Object.assign(new Error(t(key)), { i18nKey: key });
}

async function importCurrentProject(provider, vscode, resource) {
    if (vscode.workspace.isTrusted === false) throw fail((key) => provider._t(key), "keil.trustRequired");
    if (provider._espIdfRunning) throw fail((key) => provider._t(key), "esp.busy");
    const reference = resource || vscode.window.activeTextEditor?.document.uri;
    const [esp, keil] = await Promise.all([findEspIdfProjects(vscode, reference), findKeilProjects(vscode, reference)]);
    if (!esp.length) return importKeilProject(provider, vscode, { resource });
    const candidates = [
        ...esp.map((root) => ({ label: path.basename(root), description: root, kind: "esp", root })),
        ...keil.map((file) => ({ label: path.basename(file), description: file, kind: "keil", file }))
    ];
    const selected =
        candidates.length === 1
            ? candidates[0]
            : await vscode.window.showQuickPick(candidates, {
                  placeHolder: provider._t("esp.chooseProject"),
                  matchOnDescription: true
              });
    if (!selected) return null;
    if (selected.kind === "keil")
        return importKeilProject(provider, vscode, { resource: vscode.Uri.file(selected.file) });
    const project = await readEspIdfProject(selected.root);
    if (!project) throw fail((key) => provider._t(key), "esp.projectChanged");
    provider._assertConnectionEditable({ debugger: true, mcu: true });
    if (provider._espIdfRunning) throw fail((key) => provider._t(key), "esp.busy");
    const store = provider._context.workspaceState;
    if (store.get("mcu.projectType") !== "espidf") {
        await store.update(
            "mcu.previousKeilConfiguration",
            Object.fromEntries(KEIL_CONFIGURATION_KEYS.map((key) => [key, store.get(key) || ""]))
        );
    }
    // Do not leave an ARM image or OpenOCD target active for Agent and hardware routes in an ESP-IDF project.
    for (const key of KEIL_CONFIGURATION_KEYS) await store.update(key, "");
    await store.update("mcu.espIdfProject", project.root);
    await store.update("mcu.espIdfTarget", project.target);
    await store.update("mcu.projectType", "espidf");
    await provider._refreshElfBindings();
    await provider.updateView();
    provider._notices.notify("config", "mcu-vscode.readCurrentKeil", {
        level: "success",
        key: "esp.imported",
        params: { name: project.name, target: project.target || provider._t("esp.targetUnknown") }
    });
    return project;
}

async function restoreKeilConfiguration(provider) {
    if (provider._espIdfRunning) throw fail((key) => provider._t(key), "esp.busy");
    provider._assertConnectionEditable({ debugger: true, mcu: true });
    const store = provider._context.workspaceState;
    const previous = store.get("mcu.previousKeilConfiguration") || {};
    for (const key of KEIL_CONFIGURATION_KEYS)
        await store.update(key, typeof previous[key] === "string" ? previous[key] : "");
    await store.update("mcu.projectType", "keil");
    await provider._refreshElfBindings();
    await provider.updateView();
}

async function runEspIdfAction({ vscode, root, action, serialBusy, t }) {
    if (vscode.workspace.isTrusted === false) throw fail(t, "keil.trustRequired");
    if (!Object.hasOwn(ACTIONS, action)) throw new Error("Invalid ESP-IDF action");
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length !== 1 || !root) throw fail(t, "esp.openProjectRoot");
    let actualRoot, workspaceRoot;
    try {
        [actualRoot, workspaceRoot] = await Promise.all([fs.realpath(root), fs.realpath(folders[0].uri.fsPath)]);
    } catch {
        throw fail(t, "esp.openProjectRoot");
    }
    const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
    if (normalize(actualRoot) !== normalize(workspaceRoot) || !(await readEspIdfProject(actualRoot)))
        throw fail(t, "esp.openProjectRoot");
    if (action === "flash" && serialBusy()) throw fail(t, "esp.serialBusy");
    if (action === "flash" && vscode.debug?.activeDebugSession) throw fail(t, "esp.debugBusy");
    const extension = vscode.extensions.getExtension("espressif.esp-idf-extension");
    if (!extension) throw fail(t, "esp.extensionRequired");
    if (!extension.isActive) await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes(ACTIONS[action])) throw fail(t, "esp.commandUnavailable");
    // Activation can take time; check again before starting the external command.
    if (vscode.workspace.isTrusted === false) throw fail(t, "keil.trustRequired");
    if (
        (vscode.workspace.workspaceFolders || []).length !== 1 ||
        normalize(await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath)) !== normalize(actualRoot) ||
        !(await readEspIdfProject(actualRoot))
    )
        throw fail(t, "esp.openProjectRoot");
    if (action === "flash" && serialBusy()) throw fail(t, "esp.serialBusy");
    if (action === "flash" && vscode.debug?.activeDebugSession) throw fail(t, "esp.debugBusy");
    // Official commands choose their own configured port and flash method. Their API does not
    // expose a reliable success result; callers must not turn a returned promise into success.
    await vscode.commands.executeCommand(ACTIONS[action]);
}

module.exports = {
    findEspIdfProjects,
    readEspIdfProject,
    importCurrentProject,
    restoreKeilConfiguration,
    runEspIdfAction
};
