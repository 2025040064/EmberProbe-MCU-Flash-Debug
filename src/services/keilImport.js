"use strict";
const path = require("path");
const { findKeilProjects, readKeilProject, readKeilTarget, inside } = require("./keilProject");
const { detectDebugger } = require("../autoDetect");

/** @param {any} provider @param {any} vscode
 * @param {{resource?: any, browse?: boolean, automatic?: boolean}} [options] */
async function importKeilProject(provider, vscode, { resource, browse = false, automatic = false } = {}) {
    const t = (key, params = {}) => provider._t(key, params);
    if (vscode.workspace.isTrusted === false) throw new Error(t("keil.trustRequired"));
    provider._assertConnectionEditable({ debugger: true, mcu: true });
    let file = resource?.fsPath;
    if (browse) {
        const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { "Keil Project": ["uvprojx", "uvproj"] },
            title: t("keil.import")
        });
        if (!selected?.length) return null;
        file = selected[0].fsPath;
    } else if (!file || !/\.uvprojx?$/i.test(file)) {
        const projects = await findKeilProjects(vscode, resource || vscode.window.activeTextEditor?.document.uri);
        if (projects.length === 1) file = projects[0];
        else if (automatic) return false;
        else if (!projects.length) throw new Error(t("keil.noProject"));
        else
            file = (
                await vscode.window.showQuickPick(
                    projects.map((value) => ({ label: path.basename(value), description: value, value })),
                    { placeHolder: t("keil.chooseProject"), matchOnDescription: true }
                )
            )?.value;
    }
    if (!file) return null;
    const candidates = await readKeilProject(file);
    let selected = candidates.length === 1 ? candidates[0] : null;
    if (!selected && automatic) return false;
    if (!selected)
        selected = (
            await vscode.window.showQuickPick(
                candidates.map((value) => ({ label: value.name, description: value.device, value })),
                { placeHolder: t("keil.chooseTarget") }
            )
        )?.value;
    if (!selected) return null;
    const target = await readKeilTarget(selected);
    const scripts = await provider._availableOpenOcdScripts();
    if (!target.mcu || (scripts.targets.length && !scripts.targets.includes(target.mcu)))
        throw new Error(t("keil.unsupported", { device: target.device }));
    const detected = await detectDebugger({ interfaces: scripts.interfaces });
    const debuggerConfig = detected.debugger || (!detected.probeCandidates.length ? target.debugger : "");
    const projectDir = path.dirname(file);
    const root = /^(MDK-ARM|Keil|MDK)$/i.test(path.basename(projectDir)) ? path.dirname(projectDir) : projectDir;
    const iocs = (await vscode.workspace.findFiles("**/*.{ioc,IOC}", "**/node_modules/**", 100))
        .map((uri) => uri.fsPath)
        .filter((candidate) => inside(candidate, root) && !/\.emberprobe-/.test(candidate));
    // Recheck after asynchronous discovery: no settings may change during a hardware session.
    provider._assertConnectionEditable({ debugger: true, mcu: true });
    const store = provider._context.workspaceState;
    await store.update("mcu.elfPath", target.elf);
    await store.update("mcu.mcuCore", target.mcu);
    await store.update(
        "mcu.debugger",
        scripts.interfaces.length && !scripts.interfaces.includes(debuggerConfig) ? "" : debuggerConfig
    );
    await store.update("mcu.iocPath", iocs.length === 1 ? iocs[0] : "");
    await store.update("mcu.keilProject", file);
    await store.update("mcu.keilTarget", target.name);
    await store.update("mcu.projectType", "keil");
    await provider._refreshElfBindings();
    await provider.updateView();
    await provider._refreshConnectedProbes();
    provider._notices.notify("config", "mcu-vscode.importKeil", {
        level: target.elf ? "success" : "warning",
        key: target.elf
            ? "keil.imported"
            : target.firmwareStatus === "invalid"
              ? "keil.invalidFirmware"
              : "keil.buildFirst",
        params: { name: target.name, device: target.device, file: target.firmware || target.project }
    });
    return target;
}

module.exports = { importKeilProject };
