# Windows 发布流程

## 日常构建

推送到 `master`、`codex/**` 或创建 PR 时，`Windows build` 工作流会：

1. 安装锁定依赖。
2. 运行所有 `*tests.cjs` 测试。
3. 生成 x64 NSIS 安装包。
4. 生成 SHA-256 校验文件。
5. 保留 14 天构建产物供内部测试。

## 签名配置

正式发布前，在 GitHub 仓库的 `Settings → Secrets and variables → Actions` 中添加：

- `WIN_CSC_LINK`：`.pfx`/`.p12` 证书的 Base64、HTTPS 地址或 electron-builder 支持的证书位置。
- `WIN_CSC_KEY_PASSWORD`：证书密码。

证书和密码不得提交到仓库。配置了签名 Secret 但安装包签名无效时，发布工作流会直接失败。

没有签名 Secret 时可以生成内部测试包，但发布前必须明确它是未签名 Beta；Windows 可能显示“未知发布者”或 SmartScreen 警告。

## 创建发布草稿

1. 更新 `package.json` 和 `package-lock.json` 中的版本，例如 `0.1.0`。
2. 合并并确保 `Windows build` 通过。
3. 创建与版本完全一致的标签：

   ```powershell
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. `Windows release` 会创建一个 Draft + Prerelease，并上传安装包、blockmap 和 `SHA256SUMS.txt`。
5. 下载并在干净的 Windows 10/11 环境完成安装、升级、卸载和划词回归测试。
6. 确认签名、截图、隐私政策和更新说明后，在 GitHub Releases 手动发布草稿。

标签必须与 `package.json` 版本一致，否则工作流会失败。正式发布前不要直接创建 `v1.0.0` 标签。
