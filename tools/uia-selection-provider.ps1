param(
  [double]$StartX,
  [double]$StartY,
  [double]$EndX,
  [double]$EndY,
  [string]$ForegroundProcess = "",
  [string]$ForegroundTitle = ""
)

$ErrorActionPreference = "Stop"

function Write-Json($obj) {
  $json = ConvertTo-Json -InputObject $obj -Depth 8 -Compress
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  Write-Output $json
}

function Fail($message, $method = "uia-error") {
  Write-Json ([ordered]@{
    text = ""
    confidence = 0
    method = $method
    error = $message
  })
  exit 0
}

function RectToObj($rect) {
  if ($null -eq $rect) { return $null }
  return [ordered]@{
    x = [double]$rect.X
    y = [double]$rect.Y
    width = [double]$rect.Width
    height = [double]$rect.Height
  }
}

function RectFromArray($arr) {
  if ($null -eq $arr -or $arr.Count -lt 4) { return $null }
  $xs = @()
  $ys = @()
  $rs = @()
  $bs = @()
  for ($i = 0; $i -le $arr.Count - 4; $i += 4) {
    $w = [double]$arr[$i + 2]
    $h = [double]$arr[$i + 3]
    if ($w -le 0 -or $h -le 0) { continue }
    $x = [double]$arr[$i]
    $y = [double]$arr[$i + 1]
    $xs += $x
    $ys += $y
    $rs += ($x + $w)
    $bs += ($y + $h)
  }
  if (-not $xs.Count) { return $null }
  $minX = ($xs | Measure-Object -Minimum).Minimum
  $minY = ($ys | Measure-Object -Minimum).Minimum
  $maxR = ($rs | Measure-Object -Maximum).Maximum
  $maxB = ($bs | Measure-Object -Maximum).Maximum
  return [ordered]@{
    x = [double]$minX
    y = [double]$minY
    width = [double]($maxR - $minX)
    height = [double]($maxB - $minY)
  }
}

function NormalizeText([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return "" }
  $value = ($text -replace "[\r\n\t]+", " " -replace "\s+", " ").Trim()
  # Some subtitle overlays expose a word as split letters, e.g. "O n".
  $value = $value -replace "\b([A-Za-z])\s+([A-Za-z])\b", '$1$2'
  return $value
}

function Get-ElementText($el) {
  if ($null -eq $el) { return "" }
  $values = @()
  try { $values += [string]$el.Current.Name } catch {}
  try {
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp) { $values += [string]$vp.Current.Value }
  } catch {}
  foreach ($v in $values) {
    $clean = NormalizeText $v
    if ($clean.Length -gt 0 -and $clean.Length -le 300) { return $clean }
  }
  return ""
}

function IsBadElement($el) {
  if ($null -eq $el) { return $true }
  try {
    $type = $el.Current.ControlType.ProgrammaticName
    if ($type -match "Button|Menu|ScrollBar|Slider|Edit|ComboBox") { return $true }
  } catch {}
  $name = ""
  try { $name = [string]$el.Current.Name } catch {}
  if ($name -match "播放|暂停|设置|字幕|音量|全屏|YouTube|Trancy|Chrome|Google Chrome") { return $true }
  return $false
}

function Get-Candidates($point) {
  $list = @()
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromPoint($point)
    $depth = 0
    while ($el -and $depth -lt 10) {
      if (-not (IsBadElement $el)) { $list += $el }
      $el = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($el)
      $depth += 1
    }
  } catch {}
  return @($list)
}

function SelectByEstimatedWords([string]$fullText, $rectObj, [double]$x1, [double]$x2) {
  $text = NormalizeText $fullText
  if (-not $text -or $null -eq $rectObj -or $rectObj.width -le 1) {
    return [ordered]@{ text = ""; rect = $rectObj; selectedCount = 0 }
  }

  $left = [Math]::Min($x1, $x2)
  $right = [Math]::Max($x1, $x2)
  $tokens = [regex]::Matches($text, "\S+")
  if ($tokens.Count -eq 0) {
    return [ordered]@{ text = ""; rect = $rectObj; selectedCount = 0 }
  }

  $charCount = [Math]::Max($text.Length, 1)
  $selected = New-Object System.Collections.Generic.List[string]
  foreach ($m in $tokens) {
    $tokenLeft = [double]$rectObj.x + ([double]$m.Index / $charCount) * [double]$rectObj.width
    $tokenRight = [double]$rectObj.x + ([double]($m.Index + $m.Length) / $charCount) * [double]$rectObj.width
    $tokenCenter = ($tokenLeft + $tokenRight) / 2.0
    $overlap = [Math]::Min($right, $tokenRight) - [Math]::Max($left, $tokenLeft)
    $ratio = 0
    if (($tokenRight - $tokenLeft) -gt 0) { $ratio = $overlap / ($tokenRight - $tokenLeft) }
    if (($tokenCenter -ge $left -and $tokenCenter -le $right) -or $ratio -ge 0.35) {
      $selected.Add([string]$m.Value) | Out-Null
    }
  }

  return [ordered]@{
    text = (NormalizeText ($selected -join " "))
    rect = $rectObj
    selectedCount = $selected.Count
  }
}

function Try-TextPattern($el, $startPoint, $endPoint) {
  try {
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($null -eq $pattern) { return $null }

    $startRange = $pattern.RangeFromPoint($startPoint)
    $endRange = $pattern.RangeFromPoint($endPoint)
    if ($null -eq $startRange -or $null -eq $endRange) { return $null }

    $startRange.ExpandToEnclosingUnit([System.Windows.Automation.TextUnit]::Word)
    $endRange.ExpandToEnclosingUnit([System.Windows.Automation.TextUnit]::Word)

    $range = $startRange.Clone()
    $cmp = $startRange.CompareEndpoints(
      [System.Windows.Automation.TextPatternRangeEndpoint]::Start,
      $endRange,
      [System.Windows.Automation.TextPatternRangeEndpoint]::Start
    )

    if ($cmp -le 0) {
      $range.MoveEndpointByRange(
        [System.Windows.Automation.TextPatternRangeEndpoint]::End,
        $endRange,
        [System.Windows.Automation.TextPatternRangeEndpoint]::End
      ) | Out-Null
    } else {
      $range = $endRange.Clone()
      $range.MoveEndpointByRange(
        [System.Windows.Automation.TextPatternRangeEndpoint]::End,
        $startRange,
        [System.Windows.Automation.TextPatternRangeEndpoint]::End
      ) | Out-Null
    }

    $text = NormalizeText ($range.GetText(300))
    $rect = RectFromArray @($range.GetBoundingRectangles())
    if ($text.Length -gt 0 -and $text.Length -le 300) {
      return [ordered]@{
        text = $text
        fullText = NormalizeText ($pattern.DocumentRange.GetText(300))
        rect = $rect
        confidence = 0.88
        method = "uia-textpattern-rangefrompoint"
      }
    }
  } catch {}
  return $null
}

try {
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  Fail "UIAutomation assemblies unavailable" "uia-assembly-unavailable"
}

if ($StartX -eq 0 -and $StartY -eq 0 -and $EndX -eq 0 -and $EndY -eq 0) {
  Fail "missing cursor coordinates" "uia-missing-coordinates"
}

$sx = [Math]::Round($StartX)
$sy = [Math]::Round($StartY)
$ex = [Math]::Round($EndX)
$ey = [Math]::Round($EndY)
$midX = [Math]::Round(($sx + $ex) / 2.0)
$midY = [Math]::Round(($sy + $ey) / 2.0)

$startPoint = New-Object System.Windows.Point($sx, $sy)
$endPoint = New-Object System.Windows.Point($ex, $ey)
$midPoint = New-Object System.Windows.Point($midX, $midY)

$candidates = @()
$candidates += @(Get-Candidates $midPoint)
$candidates += @(Get-Candidates $startPoint)
$candidates += @(Get-Candidates $endPoint)
$seen = @{}

foreach ($el in $candidates) {
  if ($null -eq $el) { continue }
  $key = ""
  try { $key = $el.GetHashCode().ToString() + "|" + $el.Current.AutomationId + "|" + $el.Current.Name } catch { $key = [guid]::NewGuid().ToString() }
  if ($seen[$key]) { continue }
  $seen[$key] = $true

  $tp = Try-TextPattern $el $startPoint $endPoint
  if ($tp -and $tp.text) {
    $tp["appName"] = $ForegroundProcess
    $tp["windowTitle"] = $ForegroundTitle
    Write-Json $tp
    exit 0
  }

  $fullText = Get-ElementText $el
  if (-not $fullText) { continue }
  $rect = $null
  try { $rect = RectToObj $el.Current.BoundingRectangle } catch {}
  if ($null -eq $rect -or $rect.width -le 20 -or $rect.height -le 8) { continue }

  $estimated = SelectByEstimatedWords $fullText $rect $sx $ex
  if ($estimated.text) {
    Write-Json ([ordered]@{
      text = $estimated.text
      fullText = $fullText
      rect = $estimated.rect
      confidence = 0.30
      method = "uia-name-estimated-word-hit-test"
      appName = $ForegroundProcess
      windowTitle = $ForegroundTitle
      selectedCount = $estimated.selectedCount
    })
    exit 0
  }
}

Fail "no readable UIA text at cursor" "uia-no-readable-text"
