"use strict";
const fs = require("fs/promises");
const path = require("path");
const { XMLParser, XMLValidator } = require("fast-xml-parser");
const targets = require("../../skills/_emberprobe/target-detection");

function parseCpuMemory(cpu) {
    const regions = [];
    for (const match of String(cpu || "").matchAll(
        /\b(IRAM\d*|IROM\d*)\s*\(\s*(0x[\da-f]+|\d+)\s*([,-])\s*(0x[\da-f]+|\d+)\s*\)/gi
    )) {
        const origin = Number(match[2]),
            endOrSize = Number(match[4]),
            capacity = match[3] === "-" ? endOrSize - origin + 1 : endOrSize;
        if (
            !Number.isSafeInteger(origin) ||
            !Number.isSafeInteger(endOrSize) ||
            !Number.isSafeInteger(capacity) ||
            origin < 0 ||
            capacity <= 0 ||
            origin + capacity > 0x100000000
        )
            return [];
        if (regions.some((r) => origin < r.origin + r.capacity && r.origin < origin + capacity)) return [];
        regions.push({ name: match[1].toUpperCase(), origin, capacity });
    }
    return regions;
}

function parseKeilProject(text, file) {
    if (Buffer.byteLength(text, "utf8") > targets.MAX_PROJECT_FILE_BYTES || /<!DOCTYPE|<!ENTITY/i.test(text))
        throw new Error("Unsupported or oversized Keil XML");
    if (XMLValidator.validate(text) !== true) throw new Error("Invalid Keil XML");
    const document = new XMLParser({ parseTagValue: false, processEntities: true }).parse(text);
    const entries = document.Project?.Targets?.Target;
    if (!entries) throw new Error("No Keil targets found");
    return (Array.isArray(entries) ? entries : [entries]).map((entry) => {
        const common = entry.TargetOption?.TargetCommonOption || {};
        const name = String(entry.TargetName || "").trim();
        const device = String(common.Device || "").trim();
        const outputName = String(common.OutputName || "").trim();
        const outputDir = String(common.OutputDirectory || ".").replace(/[\\/]/g, path.sep);
        const unresolved = /[$%]/.test(outputName + outputDir);
        const suffix = path.extname(outputName);
        const firmware =
            outputName && !unresolved && String(common.CreateExecutable) !== "0"
                ? path.resolve(path.dirname(file), outputDir, suffix ? outputName : outputName + ".axf")
                : "";
        // Some toolchains append .axf even when the configured output name already contains a dot.
        const firmwareAlternates =
            firmware && suffix && !/\.(axf|elf)$/i.test(outputName)
                ? [path.resolve(path.dirname(file), outputDir, outputName + ".axf")]
                : [];
        const driver = String(entry.TargetOption?.DebugOption?.TargetDlls?.Driver || "");
        const debuggerConfig = /st.?link/i.test(driver)
            ? "stlink.cfg"
            : /j.?link|segger/i.test(driver)
              ? "jlink.cfg"
              : /cmsis.?dap|ul2cm3/i.test(driver)
                ? "cmsis-dap.cfg"
                : "";
        return {
            project: file,
            name,
            device,
            firmware,
            firmwareAlternates,
            memoryRegions: parseCpuMemory(common.Cpu),
            mcu: targets.targetFromText(`<Device>${device}</Device>`),
            debugger: debuggerConfig
        };
    });
}

async function readKeilProject(file) {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > targets.MAX_PROJECT_FILE_BYTES) throw new Error("Invalid Keil project size");
    return parseKeilProject(await fs.readFile(file, "utf8"), file);
}

async function readKeilTarget(target) {
    if (!target.firmware) return { ...target, elf: "", firmwareStatus: "missing" };
    for (const firmware of [target.firmware, ...(target.firmwareAlternates || [])]) {
        let handle;
        try {
            handle = await fs.open(firmware, "r");
            const header = Buffer.alloc(52);
            const { bytesRead } = await handle.read(header, 0, header.length, 0);
            const valid = bytesRead === 52 && targets.elfHeaderInfo(header)?.arch === "arm";
            return { ...target, firmware, elf: valid ? firmware : "", firmwareStatus: valid ? "ready" : "invalid" };
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        } finally {
            await handle?.close();
        }
    }
    return { ...target, elf: "", firmwareStatus: "missing" };
}

function inside(file, root) {
    const relative = path.relative(root, file);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

async function findKeilProjects(vscode, resource) {
    const files = await vscode.workspace.findFiles(
        "**/*.{uvprojx,uvproj,UVPROJX,UVPROJ}",
        targets.PROJECT_EXCLUDE_GLOB,
        100
    );
    const folder = resource && vscode.workspace.getWorkspaceFolder?.(resource);
    let candidates = files.map((uri) => uri.fsPath).filter((file) => !folder || inside(file, folder.uri.fsPath));
    // An editor file narrows discovery to its nearest ancestor containing a Keil project,
    // including sibling MDK-ARM directories generated by CubeMX.
    if (resource && folder) {
        let directory = path.dirname(resource.fsPath);
        while (inside(directory, folder.uri.fsPath)) {
            const nearby = candidates.filter((file) => inside(file, directory));
            if (nearby.length) {
                candidates = nearby;
                break;
            }
            const parent = path.dirname(directory);
            if (parent === directory) break;
            directory = parent;
        }
    }
    return candidates.sort();
}

module.exports = { parseKeilProject, readKeilProject, readKeilTarget, findKeilProjects, inside, parseCpuMemory };
