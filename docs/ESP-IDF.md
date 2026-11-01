# ESP-IDF 工程接入

EmberProbe 可识别带有 ESP-IDF `project.cmake` 的工程，读取 `sdkconfig`（或尚未生成 `sdkconfig` 时的 `sdkconfig.defaults`）中的 `CONFIG_IDF_TARGET`，不按芯片型号硬编码固件或分区。此识别不读取实物芯片，也不自动修改目标。

## 使用

1. 在 VS Code 中单独打开 ESP-IDF 工程根目录，并信任工作区。
2. 安装并配置乐鑫官方 ESP-IDF 扩展，选择已安装的 SDK、芯片目标和烧录方式。
3. 点击 EmberProbe 的“一键识别并导入”。如工作区包含多个工程，选择需要的工程。
4. 在 ESP-IDF 模式下，可通过“编译 ESP-IDF 工程”和“选择 ESP-IDF 端口”调用官方扩展；“烧录”和“ESP-IDF 调试”同样由官方扩展处理。使用 EmberProbe 串口监视器前，确保其他工具已释放端口。
5. 如需切换回之前的 STM32 配置，可点击“返回 STM32 配置”；也可直接导入 Keil 工程。

ESP-IDF 扩展负责环境、工具链、分区、芯片及烧录方式；它的命令接口不能保证向 EmberProbe 返回实际烧录结果。因此命令结束后请以 ESP-IDF 输出中的结果为准。烧录期间 EmberProbe 禁止打开自己的串口，已打开串口需要先关闭。

目前 ESP-IDF 操作要求工程根目录是唯一工作区文件夹，避免官方扩展的当前工程指向其他目录；多根工作区请单独打开目标工程。ESP-IDF 调试使用官方扩展配置，不启用 EmberProbe 的 ARM 实时变量与 STM32 寄存器功能。支持范围取决于所用 ESP-IDF 和官方扩展版本，不能把自动识别理解为所有芯片、探针或开发板均已实测。

参考：[ESP-IDF VS Code 扩展](https://github.com/espressif/vscode-esp-idf-extension)；[ESP-IDF 构建系统](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/build-system.html)。
