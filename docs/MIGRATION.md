# User Data Migration Guide

## 问题

当 package.json 的 
ame 字段发生变化时，Electron 的 pp.getPath('userData') 会返回不同的路径，导致应用读取到空的默认配置。

## 原因

2026-07-07：项目名称从 i-selection-desktop 改为 jiaohua-ai-selection-assistant。

| 字段 | 旧值 | 新值 |
|---|---|---|
| package.json name | ai-selection-desktop | jiaohua-ai-selection-assistant |
| userData 路径 | %APPDATA%\ai-selection-desktop\data\ | %APPDATA%\jiaohua-ai-selection-assistant\data\ |

应用启动后读取新路径下的配置，但该路径只有刚创建的默认配置（store.json 约 9KB），旧路径下的真实配置（store.json 约 68KB + provider-config.json + hotkey-config.json）没有被自动迁移。

## 症状

- 应用启动后像回到初始状态
- 技能列表恢复默认
- API 配置丢失
- 历史记录为空
- Obsidian Vault 路径丢失
- 快捷键恢复默认

## 解决方案

### 手动迁移

`powershell
# 备份新旧配置
 = "C:\Users\414yb\AppData\Roaming\jiaohua-ai-selection-assistant\data\backup-20260707-143602"
New-Item -ItemType Directory -Force 
Copy-Item "C:\Users\414yb\AppData\Roaming\ai-selection-desktop\data" "\old-data" -Recurse
Copy-Item "C:\Users\414yb\AppData\Roaming\jiaohua-ai-selection-assistant\data" "\new-data" -Recurse

# 迁移
Copy-Item "C:\Users\414yb\AppData\Roaming\ai-selection-desktop\data\store.json"       "C:\Users\414yb\AppData\Roaming\jiaohua-ai-selection-assistant\data\store.json" -Force
Copy-Item "C:\Users\414yb\AppData\Roaming\ai-selection-desktop\data\provider-config.json" "C:\Users\414yb\AppData\Roaming\jiaohua-ai-selection-assistant\data\provider-config.json" -Force
Copy-Item "C:\Users\414yb\AppData\Roaming\ai-selection-desktop\data\hotkey-config.json"  "C:\Users\414yb\AppData\Roaming\jiaohua-ai-selection-assistant\data\hotkey-config.json" -Force
`

### 自动迁移

应用启动时会自动检测并执行迁移，日志见控制台：
`
[Migration] migrated user data from ai-selection-desktop to jiaohua-ai-selection-assistant
`

## 预防

- 不要随意修改 package.json 的 name 字段
- 如果修改，确保用户数据已迁移
- 应用已有自动迁移逻辑，首次启动新名称时会自动复制旧配置
