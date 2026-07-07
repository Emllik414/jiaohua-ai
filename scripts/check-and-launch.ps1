# 饺划-AI划词助手 - 启动检查与启动脚本
$projectDir = "D:\项目管理\JiaoHua AI"
$logDir = Join-Path $projectDir "logs"
$logFile = Join-Path $logDir "launcher.log"
$port = 17321

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log($msg) {
    $ts = Get-Date -Format "HH:mm:ss"
    "[$ts] $msg" | Out-File $logFile -Append
}

Write-Log "========================================"
Write-Log "启动 饺划-AI划词助手 开发模式"

# Step 1: Check port 17321
$portInUse = $false
try {
    $client = New-Object System.Net.Sockets.TcpClient
    $task = $client.ConnectAsync('127.0.0.1', $port)
    if ($task.Wait(1000) -and $client.Connected) {
        $portInUse = $true
        $client.Close()
    }
} catch {}

if ($portInUse) {
    Write-Log "应用已运行（端口 $port），跳过启动"
    Write-Host "`n[饺划] 应用已在运行中，请勿重复启动。`n"
    Start-Sleep -Seconds 3
    exit 0
}

# Step 2: Check existing Electron process
$procExists = $false
try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        if ($p.CommandLine -like '*JiaoHua AI*' -or $p.CommandLine -like '*jiaohua*ai*') {
            $procExists = $true
            break
        }
    }
} catch {}

if ($procExists) {
    Write-Log "应用已运行（检测到 Electron 进程），跳过启动"
    Write-Host "`n[饺划] 检测到已有 Electron 进程在运行，跳过启动。"
    Write-Host "[饺划] 如需重启，请先关闭旧进程。`n"
    Start-Sleep -Seconds 3
    exit 0
}

# Step 3: Start the application
Set-Location $projectDir
Write-Log "工作目录: $projectDir"
Write-Log "执行: npm.cmd start (WindowStyle Hidden)"

# Launch with hidden window (doesn't block)
Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory $projectDir -WindowStyle Hidden

# Step 4: Quick verification
Write-Host "正在启动 饺划-AI划词助手 ..."
Start-Sleep -Seconds 8

$started = $false
try {
    $client = New-Object System.Net.Sockets.TcpClient
    $task = $client.ConnectAsync('127.0.0.1', $port)
    if ($task.Wait(2000) -and $client.Connected) {
        $started = $true
        $client.Close()
    }
} catch {}

if ($started) {
    Write-Log "启动成功（端口 $port 可访问）"
    Write-Host "`n[饺划] 启动成功！应用已在后台运行。"
    Write-Host "[饺划] 日志文件: $logFile`n"
} else {
    Write-Log "端口 $port 未就绪（应用可能启动较慢）"
    Write-Host "`n[饺划] 启动命令已执行，正在等待应用就绪..."
    Write-Host "[饺划] npm 输出已写入执行窗口。"
    Write-Host "[饺划] 日志文件: $logFile`n"
}
Start-Sleep -Seconds 3