# Keil 工程导入

## 使用

1. 在 Keil 中编译工程，保留调试信息。
2. 在 VS Code 打开工程文件夹。
3. 打开 EmberProbe，点击「导入 Keil 工程」，选择 `.uvprojx` 或 `.uvproj`。也可以在资源管理器右键工程文件执行同名命令。
4. 单个 Target 自动选取，多个 Target 时选择需要的一个。芯片、固件路径和调试器配置自动填写。
5. 日后重新编译，点击「读取当前 Keil 工程」。正在编辑 C 文件时，会从其所属工作区中寻找最近的 Keil 工程；多个工程时列出候选。

首次打开未选择固件的工作区，侧栏会尝试自动导入唯一的 Keil 工程和 Target。多个候选不会在后台随意选择。当前 Target、固件名称和 MCU 配置显示在导入入口下方。高级设置保留手动调整。

## 识别规则

- 读取所选 Target 的 `Device`、`OutputDirectory`、`OutputName`、`CreateExecutable` 和 `DebugOption/TargetDlls/Driver`。
- 根据输出目录定位 AXF/ELF，只读取固定长度文件头验证 ARM ELF。不会按修改时间误选其他 Target 的输出。
- 无固件或文件格式错误时清除旧固件绑定并提示重新编译，不执行构建脚本。
- 已连接的唯一探针优先；无探针时，可从 Keil 驱动名称识别 ST-Link、J-Link 或 CMSIS-DAP。无法判断时在「已连接调试器」中选择，不会自动更换驱动。
- 工程目录下唯一的 `.ioc` 自动关联；Keil 工程放在 MDK-ARM、MDK、Keil 子目录时，也检查上一层工程目录。没有 `.ioc` 不影响导入。
- SVD 保持可选，不由 Keil 导入生成。

## 限制

这里只读取工程文件，不接管其他扩展提供的 Keil UVision Project 面板。该面板中未保存到工程文件的 Target 选择不会同步。多个 Target 由 EmberProbe 单独确认。

不支持替换 Keil 输出路径中的环境变量或宏；不支持自动运行 Keil 编译。未支持的芯片拒绝导入并保留原配置。没有在真实开发板上验证烧录与调试。
