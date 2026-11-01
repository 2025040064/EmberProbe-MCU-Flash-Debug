"use strict";
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { readKeilProject, readKeilTarget, findKeilProjects } = require("./keilProject");

async function buildKeilProject({ trusted, project, target, executable, validate, run }) {
    if (!trusted) throw new Error("A trusted workspace is required");
    if (!project || !target || !(await validate(project, target))) throw new Error("Invalid Keil project or target");
    if (!executable) throw new Error("Keil executable not selected");
    const result = await run(executable, ["-b", project, "-t", target]);
    const errors = [...result.log.matchAll(/\b(\d+)\s+Error\(s\)/gi)];
    return {
        ...result,
        ok: (result.code === 0 || result.code === 1) && errors.length > 0 && Number(errors.at(-1)[1]) === 0
    };
}

async function runKeil(executable, args) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-keil-"));
    const logFile = path.join(directory, "build.log");
    try {
        const result = await new Promise((resolve, reject) => {
            execFile(
                executable,
                [...args, "-o", logFile],
                { windowsHide: true, timeout: 600000 },
                (error, stdout, stderr) => {
                    if (error && typeof error.code !== "number") return reject(error);
                    resolve({ code: error ? error.code : 0, stdout, stderr });
                }
            );
        });
        const bytes = await fs.readFile(logFile).catch(() => Buffer.alloc(0));
        const log =
            bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
        return { code: result.code, log: log || result.stdout || result.stderr || "No build log produced." };
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

function selectKeilTargetsForFile(targets, file) {
    const normal = (value) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
    return targets.filter((target) => (target.sources || []).some((source) => normal(source) === normal(file)));
}

async function resolveCurrentKeilTarget(provider, vscode) {
    const editor = vscode.window.activeTextEditor || provider._lastSourceEditor;
    const document = editor?.document;
    if (!document || document.uri.scheme !== "file") throw new Error(provider._t("keil.openFileFirst"));
    const resource = document.uri;
    if (!vscode.workspace.getWorkspaceFolder(resource)) throw new Error(provider._t("keil.fileOutsideWorkspace"));
    if (document.isDirty && !(await document.save())) throw new Error(provider._t("keil.saveFailed"));
    const projects = /\.uvprojx?$/i.test(resource.fsPath)
        ? [resource.fsPath]
        : await findKeilProjects(vscode, resource);
    let candidates = [];
    const allTargets = [];
    for (const project of projects) {
        const targets = await readKeilProject(project);
        allTargets.push(...targets);
        const matches = /\.uvprojx?$/i.test(resource.fsPath)
            ? targets
            : selectKeilTargetsForFile(targets, resource.fsPath);
        candidates.push(...matches);
    }
    const chooseForHeader = !candidates.length && /\.(h|hpp|hxx)$/i.test(resource.fsPath);
    if (chooseForHeader) candidates = allTargets;
    if (!candidates.length) throw new Error(provider._t("keil.fileNotInProject"));
    if (candidates.length === 1 && !chooseForHeader) return candidates[0];
    const selected = await vscode.window.showQuickPick(
        candidates.map((item) => ({
            label: item.name,
            description: item.project,
            value: item
        })),
        {
            placeHolder: provider._t(chooseForHeader ? "keil.chooseHeaderTarget" : "keil.chooseTarget"),
            matchOnDescription: true
        }
    );
    return selected?.value || null;
}

async function executeKeilBuild(provider, vscode) {
    const cmd = "mcu-vscode.keilBuild";
    if (provider._keilBuildRunning) throw new Error(provider._t("keil.buildBusy"));
    const store = provider._context.workspaceState;
    if (vscode.workspace.isTrusted === false) throw new Error(provider._t("keil.trustRequired"));
    provider._assertConnectionEditable({ debugger: true, mcu: true });
    const selectedTarget = await resolveCurrentKeilTarget(provider, vscode);
    if (!selectedTarget) return false;
    const project = selectedTarget.project,
        target = selectedTarget.name;
    let executable = provider._context.globalState.get("mcu.keilExecutable");
    if (
        executable &&
        !(await fs
            .stat(executable)
            .then((s) => s.isFile())
            .catch(() => false))
    )
        executable = "";
    if (!executable) {
        const choices = ["C:/Keil_v5/UV4/UV4.exe", "D:/Keil_v5/UV4/UV4.exe", "D:/Keil/UV4/UV4.exe"];
        for (const candidate of choices) {
            if (
                await fs
                    .stat(candidate)
                    .then((s) => s.isFile())
                    .catch(() => false)
            ) {
                executable = candidate;
                break;
            }
        }
    }
    if (!executable) {
        const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { "Keil uVision": ["exe"] },
            title: provider._t("keil.chooseExecutable")
        });
        executable = selected?.[0]?.fsPath;
        if (!executable) return false;
    }
    await provider._context.globalState.update("mcu.keilExecutable", executable);
    if (provider._keilBuildRunning) throw new Error(provider._t("keil.buildBusy"));
    provider._assertConnectionEditable({ debugger: true, mcu: true });
    provider._keilBuildRunning = true;
    const output = vscode.window.createOutputChannel("EmberProbe Keil");
    provider._context.subscriptions.push(output);
    try {
        provider._notices.notify("config", cmd, { level: "info", busy: true, key: "keil.buildRunning" });
        output.show(true);
        output.appendLine(`Project: ${project}\nTarget: ${target}`);
        const result = await buildKeilProject({
            trusted: vscode.workspace.isTrusted !== false,
            project,
            target,
            executable,
            validate: async (file, name) =>
                !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)) &&
                (await readKeilProject(file)).some((item) => item.name === name),
            run: runKeil
        });
        output.appendLine(result.log);
        if (!result.ok) {
            provider._notices.notify("config", cmd, { level: "error", key: "keil.buildFailed" });
            return false;
        }
        if (
            store.get("mcu.keilProject") === project &&
            store.get("mcu.keilTarget") === target &&
            store.get("mcu.projectType") !== "espidf"
        ) {
            provider._assertConnectionEditable({ debugger: true, mcu: true });
            const selected = (await readKeilProject(project)).find((item) => item.name === target);
            const firmware = await readKeilTarget(selected);
            if (firmware.elf) {
                await store.update("mcu.elfPath", firmware.elf);
                await provider._refreshElfBindings();
                await provider.updateView();
            }
        }
        provider._notices.notify("config", cmd, { level: "success", key: "keil.buildDone" });
        return true;
    } finally {
        provider._keilBuildRunning = false;
    }
}
module.exports = { buildKeilProject, executeKeilBuild, selectKeilTargetsForFile, resolveCurrentKeilTarget };
