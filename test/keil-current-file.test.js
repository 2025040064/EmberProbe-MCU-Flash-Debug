"use strict";
const assert = require("assert");
const path = require("path");
const { parseKeilProject } = require("../src/services/keilProject");
const { selectKeilTargetsForFile } = require("../src/services/keilBuild");
const project = path.resolve("workspace/MDK-ARM/app.uvprojx");
const xml = `<Project><Targets><Target><TargetName>A</TargetName><Groups><Group><Files><File><FilePath>..\\Core\\Src\\main.c</FilePath></File></Files></Group></Groups></Target><Target><TargetName>B</TargetName><Groups><Group><Files><File><FilePath>..\\Other\\main.c</FilePath></File></Files></Group></Groups></Target></Targets></Project>`;
const targets = parseKeilProject(xml, project);
assert.deepStrictEqual(
    selectKeilTargetsForFile(targets, path.resolve("workspace/Core/Src/main.c")).map((x) => x.name),
    ["A"]
);
assert.deepStrictEqual(
    selectKeilTargetsForFile(targets, path.resolve("workspace/Other/main.c")).map((x) => x.name),
    ["B"]
);
assert.deepStrictEqual(selectKeilTargetsForFile(targets, path.resolve("workspace/Else/main.c")), []);
console.log("Keil current-file target matching tests passed");

(async () => {
    const fs = require("fs/promises");
    const os = require("os");
    const { resolveCurrentKeilTarget } = require("../src/services/keilBuild");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-current-"));
    try {
        const projectFile = path.join(root, "board.uvprojx"),
            source = path.join(root, "main.c");
        await fs.writeFile(
            projectFile,
            `<Project><Targets><Target><TargetName>Board</TargetName><Groups><Group><Files><File><FilePath>main.c</FilePath></File></Files></Group></Groups></Target></Targets></Project>`
        );
        let saved = 0,
            selected = 0;
        const document = {
            uri: { scheme: "file", fsPath: source },
            isDirty: true,
            save: async () => {
                saved++;
                return true;
            }
        };
        const vscode = {
            window: {
                activeTextEditor: { document },
                showQuickPick: async (items) => {
                    selected++;
                    return items[0];
                }
            },
            workspace: {
                getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
                findFiles: async () => [{ fsPath: projectFile }]
            }
        };
        const provider = { _t: (key) => key };
        assert.strictEqual((await resolveCurrentKeilTarget(provider, vscode)).name, "Board");
        assert.strictEqual(saved, 1);
        document.uri.fsPath = path.join(root, "config.h");
        document.isDirty = false;
        assert.strictEqual((await resolveCurrentKeilTarget(provider, vscode)).name, "Board");
        assert.strictEqual(selected, 1, "unlisted header must ask before choosing a target");
        document.uri.fsPath = path.join(root, "unrelated.c");
        await assert.rejects(() => resolveCurrentKeilTarget(provider, vscode), /fileNotInProject/);
        console.log("Current file save, header selection and missing source tests passed");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
