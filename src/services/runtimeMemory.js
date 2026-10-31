"use strict";
const { writableRamSectionRanges } = require("./liveWatchService");
const NAMES = ["emberprobe_ram_used_bytes", "emberprobe_ram_total_bytes"];

function runtimeMemoryItems(result) {
    const ranges = writableRamSectionRanges(result?.memory?.sections);
    const items = NAMES.map((name) => {
        const matches = (result?.symbols || []).filter((symbol) => symbol.name === name);
        if (matches.length !== 1) return null;
        const symbol = matches[0],
            address = Number(symbol.address);
        if (
            !Number.isSafeInteger(address) ||
            address % 4 ||
            Number(symbol.size) !== 4 ||
            !ranges.some((range) => address >= range.start && address + 4 <= range.end)
        )
            return null;
        return { name, address, size: 4, type: "u32" };
    });
    return items.every(Boolean) ? items : [];
}

function decodeRuntimeMemory(samples) {
    const selected = NAMES.map((name) => samples.find((entry) => entry.name === name));
    if (selected.every((sample) => !sample)) return null;
    if (selected.some((sample) => !sample)) return { state: "invalid" };
    if (selected.some((sample) => sample.diagnostic || !sample.bytes || sample.bytes.length < 4))
        return { state: "invalid" };
    const values = selected.map((sample) => Buffer.from(sample.bytes).readUInt32LE(0));
    const [used, total] = values;
    if (!total || used > total) return { state: "invalid" };
    return { state: "ready", used, total };
}
module.exports = { runtimeMemoryItems, decodeRuntimeMemory };
