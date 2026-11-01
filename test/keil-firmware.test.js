"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { resolveImportedKeilFirmware } = require("../src/services/keilFirmware");
(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-firmware-"));
    try {
        const file = path.join(root, "project.uvprojx");
        await fs.writeFile(
            file,
            `<Project><Targets><Target><TargetName>Board</TargetName><TargetOption><TargetCommonOption><Device>STM32F103C8</Device><OutputDirectory>Objects</OutputDirectory><OutputName>demo</OutputName><CreateExecutable>1</CreateExecutable></TargetCommonOption></TargetOption></Target></Targets></Project>`
        );
        const store = {
            get: (key) =>
                ({
                    "mcu.projectType": "keil",
                    "mcu.keilProject": file,
                    "mcu.keilTarget": "Board",
                    "mcu.mcuCore": "stm32f1x.cfg"
                })[key]
        };
        await assert.rejects(() => resolveImportedKeilFirmware(store), /missing/i);
        await fs.mkdir(path.join(root, "Objects"));
        const elf = path.join(root, "Objects", "demo.axf");
        await fs.writeFile(elf, "broken");
        await assert.rejects(() => resolveImportedKeilFirmware(store), /invalid/i);
        const bytes = Buffer.alloc(52);
        bytes.writeUInt32BE(0x7f454c46);
        bytes[4] = bytes[5] = bytes[6] = 1;
        bytes.writeUInt16LE(40, 18);
        await fs.writeFile(elf, bytes);
        assert.strictEqual(await resolveImportedKeilFirmware(store), elf);
        await assert.rejects(
            () => resolveImportedKeilFirmware({ get: (key) => (key === "mcu.keilTarget" ? "Other" : store.get(key)) }),
            /target/i
        );
        assert.strictEqual(await resolveImportedKeilFirmware({ get: () => undefined }), null);
        console.log("Keil output refresh and failure tests passed");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
