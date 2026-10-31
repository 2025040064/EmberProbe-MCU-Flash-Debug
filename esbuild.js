"use strict";

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const { isOfficialRelease } = require("./src/buildInfo");

const extensionBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "extension.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "extension.js"),
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode", "koffi", "serialport"],
    minify: false,
    sourcemap: false,
    legalComments: "eof"
});

function webviewBuild(area) {
    return esbuild.build({
        absWorkingDir: __dirname,
        entryPoints: [
            path.join(__dirname, "src", "webview", area, "renderer.js"),
            ...(area === "liveWatch" ? [path.join(__dirname, "src", "webview", area, "viewport.js")] : []),
            path.join(__dirname, "src", "webview", area, "app.css")
        ],
        bundle: true,
        outdir: path.join(__dirname, "dist", "webview", area),
        platform: "browser",
        banner: { js: require("./src/webviewTemplate").loadRendererPrelude(area) },
        format: "iife",
        target: "es2020",
        minify: false,
        sourcemap: false,
        legalComments: "none"
    });
}

const samplingBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "samplingWorker.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "samplingWorker.js"),
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["koffi"]
});
const elfBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "elfWorker.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "elfWorker.js"),
    platform: "node",
    format: "cjs",
    target: "node20"
});
const chartHistoryBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "chartHistoryWorker.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "chartHistoryWorker.js"),
    platform: "node",
    format: "cjs",
    target: "node20"
});
const svdBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "svdWorker.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "svdWorker.js"),
    platform: "node",
    format: "cjs",
    target: "node20"
});
const debugBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "debug", "adapter.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "debugAdapter.js"),
    platform: "node",
    format: "cjs",
    target: "node20",
    legalComments: "eof"
});

// MCP stdio server: a separate process that inlines the Bridge locator, diagnostics table and MCP SDK.
const mcpBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "mcp", "server.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "mcp-server.js"),
    platform: "node",
    format: "cjs",
    target: "node18",
    // Most of its size is the SDK's zod/ajv dependencies; a separate process needs no readable bundle.
    minify: true,
    legalComments: "eof"
});

function stageSamplingTimer() {
    const required = [
        "koffi/package.json",
        "koffi/index.cjs",
        "koffi/LICENSE.txt",
        "koffi/src/koffi/index.cjs",
        "koffi/src/koffi/src/static.cjs"
    ];
    const windows = [
        "@koromix/koffi-win32-x64/package.json",
        "@koromix/koffi-win32-x64/index.js",
        "@koromix/koffi-win32-x64/win32_x64/koffi.node"
    ];
    const output = path.join(__dirname, "dist", "sampling-timer", "node_modules");
    for (const name of required) {
        const source = path.join(__dirname, "node_modules", name);
        const target = path.join(output, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
    }
    for (const name of windows) {
        const source = path.join(__dirname, "node_modules", name);
        const target = path.join(output, name);
        if (fs.existsSync(source)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(source, target);
        } else fs.rmSync(target, { force: true });
    }
}

function writeBuildInfo() {
    const version = require("./package.json").version;
    fs.writeFileSync(
        path.join(__dirname, "dist", "buildInfo.json"),
        JSON.stringify({ version, officialRelease: isOfficialRelease(version, process.env.RELEASE_TAG) }) + "\n"
    );
}

// Keep the Node-API prebuilds and each package's relative runtime dependencies intact.
function stageSerialPort() {
    const seen = new Set();
    const install = (name, parent) => {
        let directory = parent;
        let manifest;
        while (true) {
            const candidate = path.join(directory, "node_modules", name, "package.json");
            if (fs.existsSync(candidate)) {
                manifest = candidate;
                break;
            }
            const next = path.dirname(directory);
            if (next === directory) throw new Error(`Missing serial dependency ${name}`);
            directory = next;
        }
        const source = path.dirname(manifest);
        const relative = path.relative(path.join(__dirname, "node_modules"), source);
        if (relative.startsWith("..") || seen.has(relative)) return;
        seen.add(relative);
        const target = path.join(__dirname, "dist", "node_modules", relative);
        fs.cpSync(source, target, {
            recursive: true,
            filter: (entry) => !path.relative(source, entry).split(path.sep).includes("node_modules")
        });
        for (const dependency of Object.keys(JSON.parse(fs.readFileSync(manifest, "utf8")).dependencies || {}))
            install(dependency, source);
    };
    install("serialport", __dirname);
}

Promise.all([
    extensionBuild,
    samplingBuild,
    chartHistoryBuild,
    elfBuild,
    svdBuild,
    debugBuild,
    mcpBuild,
    webviewBuild("sidebar"),
    webviewBuild("liveWatch")
])
    .then(() => {
        stageSamplingTimer();
        stageSerialPort();
        writeBuildInfo();
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
