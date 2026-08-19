param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Payload = "e30="
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ("ForgeComputerNative" -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct ForgePoint { public int X; public int Y; }
public struct ForgeRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class ForgeComputerNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref ForgePoint point);
  [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr hWndParent, ForgePoint point, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool PostMessage(IntPtr hWnd, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out ForgeRect rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxCount);
}
"@
}
$script:ElementCaches = @{}

$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
$argsObject = if ($json) { $json | ConvertFrom-Json } else { [pscustomobject]@{} }

function Write-Result($value) {
  $output = if ($script:WorkerRequestId) { [pscustomobject]@{ id = $script:WorkerRequestId; result = $value } } else { $value }
  [Console]::Out.WriteLine(($output | ConvertTo-Json -Depth 12 -Compress))
  [Console]::Out.Flush()
}

function Get-Windows {
  $foreground = [ForgeComputerNative]::GetForegroundWindow()
  @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Sort-Object ProcessName | ForEach-Object {
    $handle = [IntPtr]::new([int64]$_.MainWindowHandle)
    $rect = [ForgeRect]::new(); [ForgeComputerNative]::GetWindowRect($handle, [ref]$rect) | Out-Null
    $className = [Text.StringBuilder]::new(256); [ForgeComputerNative]::GetClassName($handle, $className, $className.Capacity) | Out-Null
    [pscustomobject]@{
      processId = $_.Id; process = $_.ProcessName; title = $_.MainWindowTitle; handle = [int64]$_.MainWindowHandle
      className = $className.ToString(); foreground = $handle -eq $foreground; minimized = [ForgeComputerNative]::IsIconic($handle)
      bounds = [pscustomobject]@{ x = $rect.Left; y = $rect.Top; width = [math]::Max(0, $rect.Right - $rect.Left); height = [math]::Max(0, $rect.Bottom - $rect.Top) }
    }
  })
}

function Find-Window($query, $processId, $handle = $null) {
  $items = Get-Windows
  if ($processId) { $items = @($items | Where-Object { $_.processId -eq [int]$processId }) }
  if ($handle) { $items = @($items | Where-Object { [string]$_.handle -eq [string]$handle }) }
  if ($query) { $items = @($items | Where-Object { $_.title -like "*$query*" -or $_.process -like "*$query*" }) }
  if (-not $items.Count) { throw "No matching window found" }
  if ($items.Count -ne 1) { throw "Window target is ambiguous ($($items.Count) matches); provide processId or handle" }
  return $items[0]
}

function Activate-Window($window) {
  $handle = [IntPtr]::new([int64]$window.handle)
  [ForgeComputerNative]::ShowWindowAsync($handle, 9) | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $shell.AppActivate([int]$window.processId) | Out-Null
  [ForgeComputerNative]::BringWindowToTop($handle) | Out-Null
  [ForgeComputerNative]::SwitchToThisWindow($handle, $true)
  [ForgeComputerNative]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 350
}

function Element-View($element) {
  $r = $element.Current.BoundingRectangle
  [pscustomobject]@{
    name = $element.Current.Name
    type = $element.Current.ControlType.ProgrammaticName.Replace("ControlType.", "")
    automationId = $element.Current.AutomationId
    enabled = $element.Current.IsEnabled
    offscreen = $element.Current.IsOffscreen
    bounds = [pscustomobject]@{ x = [math]::Round($r.X); y = [math]::Round($r.Y); width = [math]::Round($r.Width); height = [math]::Round($r.Height) }
  }
}

function Capture-Screen($target, $rectangle = $null) {
  if ($rectangle) {
    $screen = [pscustomobject]@{ Left = [int]$rectangle.X; Top = [int]$rectangle.Y; Width = [int]$rectangle.Width; Height = [int]$rectangle.Height }
  } else {
    $screen = [Windows.Forms.SystemInformation]::VirtualScreen
  }
  $bitmap = [Drawing.Bitmap]::new($screen.Width, $screen.Height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($target, [Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
  return $screen
}

function Capture-Window($window, $target) {
  $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]$window.handle))
  $rectangle = $root.Current.BoundingRectangle
  $width = [math]::Max(1, [int]$rectangle.Width); $height = [math]::Max(1, [int]$rectangle.Height)
  $bitmap = [Drawing.Bitmap]::new($width, $height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  try {
    if (-not [ForgeComputerNative]::PrintWindow([IntPtr]::new([int64]$window.handle), $hdc, 2)) { throw "Background window capture failed" }
  } finally { $graphics.ReleaseHdc($hdc); $graphics.Dispose() }
  try { $bitmap.Save($target, [Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
  return [pscustomobject]@{ Left = [int]$rectangle.X; Top = [int]$rectangle.Y; Width = $width; Height = $height }
}

function Background-Point($window, [int]$x, [int]$y) {
  $point = [ForgePoint]::new(); $point.X = $x; $point.Y = $y
  [ForgeComputerNative]::ScreenToClient([IntPtr]::new([int64]$window.handle), [ref]$point) | Out-Null
  return $point
}

function Background-Target($window, [int]$x, [int]$y) {
  $handle = [IntPtr]::new([int64]$window.handle)
  for ($depth = 0; $depth -lt 8; $depth++) {
    $point = [ForgePoint]::new(); $point.X = $x; $point.Y = $y
    [ForgeComputerNative]::ScreenToClient($handle, [ref]$point) | Out-Null
    $child = [ForgeComputerNative]::ChildWindowFromPointEx($handle, $point, 0x0001 -bor 0x0002)
    if ($child -eq [IntPtr]::Zero -or $child -eq $handle) { break }
    $handle = $child
  }
  $clientPoint = [ForgePoint]::new(); $clientPoint.X = $x; $clientPoint.Y = $y
  [ForgeComputerNative]::ScreenToClient($handle, [ref]$clientPoint) | Out-Null
  return [pscustomobject]@{ Handle = $handle; Point = $clientPoint }
}

function Point-LParam($point) {
  return [IntPtr]::new((($point.Y -band 0xffff) -shl 16) -bor ($point.X -band 0xffff))
}

function Post-BackgroundKey($window, [int]$virtualKey, [bool]$down = $true) {
  $message = if ($down) { 0x0100 } else { 0x0101 }
  [ForgeComputerNative]::PostMessage([IntPtr]::new([int64]$window.handle), $message, [UIntPtr]::new([uint32]$virtualKey), [IntPtr]::Zero) | Out-Null
}

function Send-BackgroundMessage($handle, [uint32]$message, [UIntPtr]$wParam, [IntPtr]$lParam) {
  $messageResult = [UIntPtr]::Zero
  $sent = [ForgeComputerNative]::SendMessageTimeout($handle, $message, $wParam, $lParam, 0x0002, 750, [ref]$messageResult)
  return $sent -ne [IntPtr]::Zero
}

function Await-WinRT($operation, [Type]$resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
  } | Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}

function Get-FileSha256($target) {
  $stream = [IO.File]::OpenRead($target)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

function Invoke-ComputerAction($Action, $argsObject) {
switch ($Action) {
  "launch" {
    $target = [string]$argsObject.target
    if (-not $target) { throw "target is required" }
    $previousWindow = [ForgeComputerNative]::GetForegroundWindow()
    $argumentList = @($argsObject.arguments | ForEach-Object { [string]$_ })
    $startParameters = @{ FilePath = $target; PassThru = $true }
    if ($argsObject.background) { $startParameters.WindowStyle = "Minimized" }
    if ($argumentList.Count) { $startParameters.ArgumentList = $argumentList }
    $process = Start-Process @startParameters
    $deadline = [DateTime]::UtcNow.AddMilliseconds($(if ($argsObject.waitMs) { [int]$argsObject.waitMs } else { 1500 }))
    while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited -and $process.MainWindowHandle -eq 0) { Start-Sleep -Milliseconds 100; $process.Refresh() }
    if ($argsObject.background -and $previousWindow -ne [IntPtr]::Zero) {
      if ($process.MainWindowHandle -ne 0) { [ForgeComputerNative]::ShowWindowAsync([IntPtr]::new([int64]$process.MainWindowHandle), 6) | Out-Null }
      [ForgeComputerNative]::SetForegroundWindow($previousWindow) | Out-Null
    }
    Write-Result ([pscustomobject]@{ ok = $true; processId = $process.Id; process = $process.ProcessName; windowHandle = [int64]$process.MainWindowHandle; mode = $(if ($argsObject.background) { "background" } else { "foreground" }) })
  }
  "windows" {
    Write-Result ([pscustomobject]@{ windows = @(Get-Windows) })
  }
  "focus" {
    $window = Find-Window $argsObject.query $argsObject.processId $argsObject.handle
    Activate-Window $window
    Write-Result ([pscustomobject]@{ ok = $true; window = $window })
  }
  "observe" {
    $window = Find-Window $argsObject.query $argsObject.processId $argsObject.handle
    if ($argsObject.focus -eq $true -or $argsObject.mode -eq "foreground") { Activate-Window $window }
    $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]$window.handle))
    $limit = if ($argsObject.maxElements) { [math]::Min([int]$argsObject.maxElements, 1000) } else { 300 }
    $maxDepth = if ($argsObject.maxDepth) { [math]::Min([int]$argsObject.maxDepth, 12) } else { 6 }
    $timeBudget = if ($argsObject.timeBudgetMs) { [math]::Min([int]$argsObject.timeBudgetMs, 4000) } else { 1200 }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = [Collections.Generic.Queue[object]]::new()
    $queue.Enqueue([pscustomobject]@{ Element = $root; Depth = 0 })
    $cache = [Collections.ArrayList]::new()
    $controls = @()
    while ($queue.Count -and $cache.Count -lt $limit -and $watch.ElapsedMilliseconds -lt $timeBudget) {
      $item = $queue.Dequeue(); $node = $item.Element; $depth = [int]$item.Depth
      $index = $cache.Add($node)
      try {
        $view = Element-View $node
        if (-not $view.offscreen -and ($view.name -or $view.automationId)) {
          $view | Add-Member -NotePropertyName index -NotePropertyValue $index
          $controls += $view
        }
      } catch {}
      if ($depth -ge $maxDepth) { continue }
      try {
        $child = $walker.GetFirstChild($node)
        while ($child -and ($queue.Count + $cache.Count) -lt $limit -and $watch.ElapsedMilliseconds -lt $timeBudget) {
          $queue.Enqueue([pscustomobject]@{ Element = $child; Depth = $depth + 1 })
          $child = $walker.GetNextSibling($child)
        }
      } catch {}
    }
    $script:ElementCaches[[string]$window.handle] = $cache
    Write-Result ([pscustomobject]@{ window = $window; controls = $controls; truncated = $queue.Count -gt 0; elapsedMs = $watch.ElapsedMilliseconds; cachedElements = $cache.Count })
  }
  "invoke" {
    $window = Find-Window $argsObject.query $argsObject.processId $argsObject.handle
    $cache = $script:ElementCaches[[string]$window.handle]
    $index = [int]$argsObject.elementIndex
    if (-not $cache -or $index -lt 0 -or $index -ge $cache.Count) { throw "Element index is stale or missing; call computer_observe again" }
    $element = $cache[$index]; $pattern = $null; $action = $null
    if ($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); $action = "invoke" }
    elseif ($element.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); $action = "select" }
    elseif ($element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle(); $action = "toggle" }
    elseif ($element.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { $pattern.Expand(); $action = "expand" }
    else { throw "Element does not expose an invokable accessibility action" }
    Write-Result ([pscustomobject]@{ ok = $true; mode = "background"; action = $action; elementIndex = $index; element = (Element-View $element) })
  }
  "set_value" {
    $window = Find-Window $argsObject.query $argsObject.processId $argsObject.handle
    $cache = $script:ElementCaches[[string]$window.handle]
    $index = [int]$argsObject.elementIndex
    if (-not $cache -or $index -lt 0 -or $index -ge $cache.Count) { throw "Element index is stale or missing; call computer_observe again" }
    $element = $cache[$index]; $pattern = $null
    if (-not $element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { throw "Element does not support background value entry" }
    $pattern.SetValue([string]$argsObject.value)
    Write-Result ([pscustomobject]@{ ok = $true; mode = "background"; elementIndex = $index; characters = ([string]$argsObject.value).Length })
  }
  "click" {
    $x = [int]$argsObject.x; $y = [int]$argsObject.y
    if ($argsObject.mode -eq "background") {
      $window = Find-Window $argsObject.query $argsObject.processId $argsObject.handle
      $target = Background-Target $window $x $y; $lparam = Point-LParam $target.Point
      $downMessage = if ($argsObject.button -eq "right") { 0x0204 } elseif ($argsObject.button -eq "middle") { 0x0207 } else { 0x0201 }
      $upMessage = if ($argsObject.button -eq "right") { 0x0205 } elseif ($argsObject.button -eq "middle") { 0x0208 } else { 0x0202 }
      $count = if ($argsObject.count) { [math]::Min([int]$argsObject.count, 3) } else { 1 }
      $downState = if ($argsObject.button -eq "right") { [UIntPtr]::new(2) } elseif ($argsObject.button -eq "middle") { [UIntPtr]::new(16) } else { [UIntPtr]::new(1) }
      $delivered = $true
      1..$count | ForEach-Object {
        $delivered = (Send-BackgroundMessage $target.Handle 0x0200 ([UIntPtr]::Zero) $lparam) -and $delivered
        $delivered = (Send-BackgroundMessage $target.Handle $downMessage $downState $lparam) -and $delivered
        $delivered = (Send-BackgroundMessage $target.Handle $upMessage ([UIntPtr]::Zero) $lparam) -and $delivered
      }
      Write-Result ([pscustomobject]@{ ok = $delivered; mode = "background"; x = $x; y = $y; count = $count; targetHandle = [int64]$target.Handle; delivered = $delivered }); break
    }
    if ($argsObject.query -or $argsObject.processId -or $argsObject.handle) { Activate-Window (Find-Window $argsObject.query $argsObject.processId $argsObject.handle) }
    [ForgeComputerNative]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 50
    $button = if ($argsObject.button) { [string]$argsObject.button } else { "left" }
    $down = if ($button -eq "right") { 0x0008 } elseif ($button -eq "middle") { 0x0020 } else { 0x0002 }
    $up = if ($button -eq "right") { 0x0010 } elseif ($button -eq "middle") { 0x0040 } else { 0x0004 }
    $count = if ($argsObject.count) { [math]::Min([int]$argsObject.count, 3) } else { 1 }
    1..$count | ForEach-Object { [ForgeComputerNative]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [ForgeComputerNative]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 90 }
    Write-Result ([pscustomobject]@{ ok = $true; x = $x; y = $y; button = $button; count = $count })
  }
  "type" {
    if ($argsObject.mode -eq "background") {
      $window = Find-Window $argsObject.query $argsObject.processId $argsObject.handle
      if ($argsObject.clearFirst) { Post-BackgroundKey $window 0x11 $true; Post-BackgroundKey $window 0x41 $true; Post-BackgroundKey $window 0x41 $false; Post-BackgroundKey $window 0x11 $false }
      $text = [string]$argsObject.text
      foreach ($character in $text.ToCharArray()) { [ForgeComputerNative]::PostMessage([IntPtr]::new([int64]$window.handle), 0x0102, [UIntPtr]::new([uint32][char]$character), [IntPtr]::Zero) | Out-Null }
      if ($argsObject.pressEnter) { Post-BackgroundKey $window 0x0D $true; Post-BackgroundKey $window 0x0D $false }
      Write-Result ([pscustomobject]@{ ok = $true; mode = "background"; characters = $text.Length }); break
    }
    if ($argsObject.query -or $argsObject.processId -or $argsObject.handle) { Activate-Window (Find-Window $argsObject.query $argsObject.processId $argsObject.handle) }
    $text = [string]$argsObject.text
    if ($argsObject.clearFirst) { [Windows.Forms.SendKeys]::SendWait("^a") }
    [Windows.Forms.Clipboard]::SetText($text)
    [Windows.Forms.SendKeys]::SendWait("^v")
    if ($argsObject.pressEnter) { [Windows.Forms.SendKeys]::SendWait("{ENTER}") }
    Write-Result ([pscustomobject]@{ ok = $true; characters = $text.Length })
  }
  "key" {
    if ($argsObject.mode -eq "background") {
      $window = Find-Window $argsObject.query $argsObject.processId $argsObject.handle
      $keys = [string]$argsObject.keys
      $map = @{ "{ENTER}" = 0x0D; "{ESC}" = 0x1B; "{TAB}" = 0x09; "{SPACE}" = 0x20; "{UP}" = 0x26; "{DOWN}" = 0x28; "{LEFT}" = 0x25; "{RIGHT}" = 0x27; "{F5}" = 0x74 }
      $ctrl = $keys.StartsWith("^")
      $token = if ($ctrl) { $keys.Substring(1).ToUpperInvariant() } else { $keys.ToUpperInvariant() }
      $virtualKey = if ($map.ContainsKey($token)) { $map[$token] } elseif ($token.Length -eq 1) { [int][char]$token } else { throw "Unsupported background key syntax: $keys" }
      if ($ctrl) { Post-BackgroundKey $window 0x11 $true }
      Post-BackgroundKey $window $virtualKey $true; Post-BackgroundKey $window $virtualKey $false
      if ($ctrl) { Post-BackgroundKey $window 0x11 $false }
      Write-Result ([pscustomobject]@{ ok = $true; mode = "background"; keys = $keys }); break
    }
    if ($argsObject.query -or $argsObject.processId -or $argsObject.handle) { Activate-Window (Find-Window $argsObject.query $argsObject.processId $argsObject.handle) }
    [Windows.Forms.SendKeys]::SendWait([string]$argsObject.keys)
    Write-Result ([pscustomobject]@{ ok = $true; keys = [string]$argsObject.keys })
  }
  "scroll" {
    if ($argsObject.mode -eq "background") {
      $window = Find-Window $argsObject.query $argsObject.processId $argsObject.handle
      $amount = if ($argsObject.amount) { [int]$argsObject.amount } else { -3 }
      $x = if ($null -ne $argsObject.x) { [int]$argsObject.x } else { 0 }; $y = if ($null -ne $argsObject.y) { [int]$argsObject.y } else { 0 }
      $lparam = [IntPtr]::new((($y -band 0xffff) -shl 16) -bor ($x -band 0xffff)); $wparam = [UIntPtr]::new([uint32]([int32]($amount * 120) -shl 16))
      [ForgeComputerNative]::PostMessage([IntPtr]::new([int64]$window.handle), 0x020A, $wparam, $lparam) | Out-Null
      Write-Result ([pscustomobject]@{ ok = $true; mode = "background"; amount = $amount }); break
    }
    if ($argsObject.query -or $argsObject.processId -or $argsObject.handle) { Activate-Window (Find-Window $argsObject.query $argsObject.processId $argsObject.handle) }
    if ($null -ne $argsObject.x -and $null -ne $argsObject.y) { [ForgeComputerNative]::SetCursorPos([int]$argsObject.x, [int]$argsObject.y) | Out-Null }
    $amount = if ($argsObject.amount) { [int]$argsObject.amount } else { -3 }
    [ForgeComputerNative]::mouse_event(0x0800, 0, 0, [uint32]([int32]($amount * 120)), [UIntPtr]::Zero)
    Write-Result ([pscustomobject]@{ ok = $true; amount = $amount })
  }
  "screenshot" {
    $target = [IO.Path]::GetFullPath([string]$argsObject.path)
    $directory = [IO.Path]::GetDirectoryName($target)
    if ($directory) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
    $window = $null
    if ($argsObject.query -or $argsObject.processId -or $argsObject.handle) { $window = Find-Window $argsObject.query $argsObject.processId $argsObject.handle }
    if ($window -and $argsObject.mode -eq "foreground") { Activate-Window $window }
    $screen = if ($window -and $argsObject.mode -ne "foreground") { Capture-Window $window $target } else { Capture-Screen $target }
    Write-Result ([pscustomobject]@{ ok = $true; path = $target; width = $screen.Width; height = $screen.Height; mode = $(if ($argsObject.mode -eq "foreground") { "foreground" } else { "background" }); window = $window })
  }
  "ocr" {
    $captureRectangle = $null
    if ($argsObject.query -or $argsObject.processId -or $argsObject.handle) {
      $window = Find-Window $argsObject.query $argsObject.processId $argsObject.handle
      if ($argsObject.mode -ne "background") { Activate-Window $window }
      $captureRectangle = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]$window.handle)).Current.BoundingRectangle
    }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
    $target = Join-Path ([IO.Path]::GetTempPath()) ("forge-ocr-" + [guid]::NewGuid().ToString("N") + ".png")
    $screen = if ($argsObject.mode -eq "background" -and $window) { Capture-Window $window $target } else { Capture-Screen $target $captureRectangle }
    try {
      $file = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($target)) ([Windows.Storage.StorageFile])
      $stream = Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
      $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $softwareBitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      if (-not $engine) { throw "Windows OCR engine is unavailable for the installed user languages" }
      $result = Await-WinRT ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
      $limit = if ($argsObject.maxLines) { [math]::Min([int]$argsObject.maxLines, 1000) } else { 300 }
      $lines = @()
      foreach ($line in $result.Lines) {
        if ($lines.Count -ge $limit) { break }
        $words = @($line.Words)
        if (-not $words.Count) { continue }
        $left = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
        $top = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
        $right = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
        $bottom = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
        $lines += [pscustomobject]@{ text = $line.Text; bounds = [pscustomobject]@{ x = [math]::Round($left + $screen.Left); y = [math]::Round($top + $screen.Top); width = [math]::Round($right - $left); height = [math]::Round($bottom - $top) } }
      }
      $imageHash = Get-FileSha256 $target
      Write-Result ([pscustomobject]@{ window = $window; lines = $lines; text = $result.Text; imageHash = $imageHash; width = $screen.Width; height = $screen.Height; mode = $(if ($argsObject.mode -eq "foreground") { "foreground" } else { "background" }); truncated = $result.Lines.Count -gt $limit })
    } finally { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue }
  }
  default { throw "Unknown computer action: $Action" }
}
}

if ($Action -eq "worker") {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    if (-not $line.Trim()) { continue }
    try {
      $request = $line | ConvertFrom-Json
      $script:WorkerRequestId = [string]$request.id
      Invoke-ComputerAction ([string]$request.action) $request.args
    } catch {
      $failure = [pscustomobject]@{ id = $script:WorkerRequestId; error = $_.Exception.Message }
      [Console]::Out.WriteLine(($failure | ConvertTo-Json -Compress)); [Console]::Out.Flush()
    } finally { $script:WorkerRequestId = $null }
  }
} else {
  Invoke-ComputerAction $Action $argsObject
}
