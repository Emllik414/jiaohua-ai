# Windows 发布流程

## 日常构建

推送到 `master`、`codex/**` 或创建 PR 时，`Windows build` 会运行全部测试、生成 Windows 构建并上传短期构建产物。

## 正式免安装发行

1. 同时更新 `package.json` 与 `package-lock.json` 的版本号。
2. 合并到 `master`，并确认所有 Windows 构建检查通过。
3. 在 `master` 创建完全一致的版本标签，例如：

   ```powershell
   git tag v1.0.0
   git push origin v1.0.0
   ```

4. `Windows portable release` 会自动：
   - 校验标签与应用版本一致；
   - 运行全部测试；
   - 构建单文件免安装版；
   - 扫描安装内容，阻止 API 配置、历史记录和 `.env` 被打包；
   - 生成 SHA-256 校验文件；
   - 创建正式 GitHub Release，并标记为 Latest。

Release 只上传 `JiaoHua-AI-Portable-vX.Y.Z.exe` 和 `SHA256SUMS.txt`，不会上传本机配置或历史数据。

## 可选代码签名

在仓库 `Settings → Secrets and variables → Actions` 中配置：

- `WIN_CSC_LINK`：代码签名证书；
- `WIN_CSC_KEY_PASSWORD`：证书密码。

证书和密码不得提交到仓库。未配置证书时仍可生成免安装版，但 Windows 可能显示未知发布者或 SmartScreen 警告。
