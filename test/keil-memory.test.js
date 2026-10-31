"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryAnalysisService } = require("../src/services/memoryAnalysisService");
const { parseCpuMemory } = require("../src/services/keilProject");
const { buildMemoryElf, snapshot } = require("./helpers/memory-fixture");

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "keil-memory-"));
    try {
        const elf = path.join(root, "fw.axf"),
            project = path.join(root, "firmware.uvprojx");
        const data = buildMemoryElf([
            { name: ".text", addr: 0x08000000, size: 1024, type: 1, flags: 6 },
            { name: ".bss", addr: 0x20000000, size: 512, type: 8, flags: 3 }
        ]);
        fs.writeFileSync(elf, data);
        fs.writeFileSync(
            project,
            `<Project><Targets><Target><TargetName>Debug</TargetName><TargetOption><TargetCommonOption><Device>STM32F103C8</Device><Cpu>IRAM(0x20000000,0x5000) IROM(0x08000000,0x10000)</Cpu><OutputDirectory>.</OutputDirectory><OutputName>fw</OutputName></TargetCommonOption></TargetOption></Target></Targets></Project>`
        );
        const service = new MemoryAnalysisService({
            elfService: { load: async () => snapshot(data, elf) },
            roots: () => [root],
            keilSelection: () => ({ project, target: "Debug" })
        });
        const result = await service.analyze();
        assert.strictEqual(result.source.kind, "keil");
        assert.strictEqual(result.regions.find((region) => region.name === "IRAM").capacity, 0x5000);
        assert.strictEqual(result.regions.find((region) => region.name === "IROM").capacity, 0x10000);
        assert(result.source.files.includes(project));
        assert.deepStrictEqual(parseCpuMemory("IRAM(0x20000000,0x2000) IRAM2(0x20001000,0x2000)"), []);
        assert.deepStrictEqual(parseCpuMemory("IRAM(0x20000000-0x20007FFF) IROM(0x08000000-0x0801FFFF)"), [
            { name: "IRAM", origin: 0x20000000, capacity: 0x8000 },
            { name: "IROM", origin: 0x08000000, capacity: 0x20000 }
        ]);
        assert.deepStrictEqual(parseCpuMemory("IRAM(0x20001000-0x20000000)"), []);
        assert.deepStrictEqual(parseCpuMemory("IRAM(0xFFFFFFF0-0x100000000)"), []);
        const unrelated = new MemoryAnalysisService({
            elfService: { load: async () => snapshot(data, path.join(root, "other.axf")) },
            roots: () => [root],
            keilSelection: () => ({ project, target: "Debug" })
        });
        assert.notStrictEqual((await unrelated.analyze()).source.kind, "keil");

        const dotted = path.join(root, "D10.10_serial");
        fs.writeFileSync(dotted, data);
        fs.writeFileSync(
            project,
            fs
                .readFileSync(project, "utf8")
                .replace("<OutputName>fw</OutputName>", "<OutputName>D10.10_serial</OutputName>")
                .replace(
                    "IRAM(0x20000000,0x5000) IROM(0x08000000,0x10000)",
                    "IRAM(0x20000000-0x20007FFF) IROM(0x08000000-0x0801FFFF)"
                )
        );
        const dottedService = new MemoryAnalysisService({
            elfService: { load: async () => snapshot(data, dotted) },
            roots: () => [root],
            keilSelection: () => ({ project, target: "Debug" })
        });
        assert.strictEqual(
            (await dottedService.analyze()).source.kind,
            "keil",
            "dotted ELF keeps target memory capacity"
        );
        let binaryMapReads = 0;
        const observedFs = {
            ...fs,
            readFileSync(file, ...args) {
                if (file === dotted) binaryMapReads++;
                return fs.readFileSync(file, ...args);
            }
        };
        const unboundService = new MemoryAnalysisService({
            fs: observedFs,
            elfService: { load: async () => snapshot(data, dotted) },
            roots: () => [root]
        });
        await unboundService.analyze();
        assert.strictEqual(binaryMapReads, 0, "the ELF itself must not be read as a .map file");
        fs.unlinkSync(dotted);
        fs.writeFileSync(dotted + ".axf", data);
        const fallbackService = new MemoryAnalysisService({
            elfService: { load: async () => snapshot(data, dotted + ".axf") },
            roots: () => [root],
            keilSelection: () => ({ project, target: "Debug" })
        });
        assert.strictEqual(
            (await fallbackService.analyze()).source.kind,
            "keil",
            "fallback ELF keeps target memory capacity"
        );
        console.log("Keil memory capacity tests passed");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
