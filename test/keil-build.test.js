"use strict";
const assert = require("assert");
const { buildKeilProject } = require("../src/services/keilBuild");
(async () => {
    let invoked;
    const api = {
        trusted: true,
        project: "C:/workspace/demo.uvprojx",
        target: "Target 1",
        executable: "C:/Keil/UV4.exe",
        validate: async () => true,
        run: async (exe, args) => {
            invoked = { exe, args };
            return { code: 0, log: '"demo.axf" - 0 Error(s), 0 Warning(s).' };
        }
    };
    const result = await buildKeilProject(api);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(invoked.args, ["-b", api.project, "-t", api.target]);
    assert.strictEqual(
        (await buildKeilProject({ ...api, run: async () => ({ code: 2, log: "1 Error(s)" }) })).ok,
        false
    );
    assert.strictEqual(
        (await buildKeilProject({ ...api, run: async () => ({ code: 0, log: "2 Error(s), 0 Warning(s)" }) })).ok,
        false
    );
    await assert.rejects(() => buildKeilProject({ ...api, trusted: false }), /trust/i);
    await assert.rejects(() => buildKeilProject({ ...api, validate: async () => false }), /project/i);
    console.log("Keil build invocation and result tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
