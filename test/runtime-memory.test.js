"use strict";
const assert = require("assert");
const { runtimeMemoryItems, decodeRuntimeMemory } = require("../src/services/runtimeMemory");
const { loadProvider } = require("./helpers/load-provider");
const names = ["emberprobe_ram_used_bytes", "emberprobe_ram_total_bytes"];
const symbols = names.map((name, index) => ({ name, address: 0x20000000 + index * 4, size: 4, watchType: "u32" }));
const sections = [{ name: ".data", addr: 0x20000000, size: 64, flags: 3 }];
const sample = (name, value) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return { name, bytes };
};

assert.deepStrictEqual(
    runtimeMemoryItems({ symbols, memory: { sections } }).map((item) => item.name),
    names
);
assert.deepStrictEqual(runtimeMemoryItems({ symbols: symbols.slice(0, 1), memory: { sections } }), []);
assert.deepStrictEqual(runtimeMemoryItems({ symbols, memory: { sections: [] } }), []);
assert.deepStrictEqual(decodeRuntimeMemory([sample(names[0], 64), sample(names[1], 128)]), {
    state: "ready",
    used: 64,
    total: 128
});
assert.deepStrictEqual(decodeRuntimeMemory([sample(names[0], 129), sample(names[1], 128)]), { state: "invalid" });
assert.deepStrictEqual(decodeRuntimeMemory([sample(names[0], 0), sample(names[1], 0)]), { state: "invalid" });
assert.deepStrictEqual(decodeRuntimeMemory([sample(names[0], 5)]), { state: "invalid" });
assert.strictEqual(decodeRuntimeMemory([{ name: "unrelated", bytes: Buffer.alloc(4) }]), null);
assert.deepStrictEqual(decodeRuntimeMemory([{ name: names[0], bytes: null }, sample(names[1], 128)]), {
    state: "invalid"
});
const Provider = loadProvider({});
const provider = Object.create(Provider.prototype);
provider.readElfSymbols = () => ({ symbols, memory: { sections } });
provider._livePanels = new Map();
provider._scalarWatchList = () => [];
provider._panelRuntimeExpansions = () => null;
provider._context = { workspaceState: { get: () => [] } };
provider._runtimeReadRanges = (items) => items;
assert.deepStrictEqual(
    provider._activeReadPlan().map((item) => item.name),
    names,
    "memory joins the existing sampling plan without changing user watches"
);
assert(names.every((name) => provider._consumerTypes().sidebar.has(name)));
console.log("Runtime memory tests passed");
