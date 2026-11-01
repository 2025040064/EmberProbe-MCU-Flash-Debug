"use strict";
const { readKeilProject, readKeilTarget } = require("./keilProject");
async function resolveImportedKeilFirmware(store) {
    const project = store.get("mcu.keilProject"),
        targetName = store.get("mcu.keilTarget");
    if (store.get("mcu.projectType") !== "keil" || !project || !targetName) return null;
    const targets = await readKeilProject(project);
    const target = targets.find((item) => item.name === targetName);
    if (!target)
        throw Object.assign(new Error("Keil target no longer exists"), { i18nKey: "keil.outputTargetMissing" });
    if (!target.mcu || target.mcu !== store.get("mcu.mcuCore"))
        throw Object.assign(new Error("Keil target changed"), { i18nKey: "keil.outputTargetChanged" });
    const result = await readKeilTarget(target);
    if (!result.elf)
        throw Object.assign(new Error("Keil firmware " + result.firmwareStatus), {
            i18nKey: result.firmwareStatus === "invalid" ? "keil.outputInvalid" : "keil.outputMissing"
        });
    return result.elf;
}
module.exports = { resolveImportedKeilFirmware };
