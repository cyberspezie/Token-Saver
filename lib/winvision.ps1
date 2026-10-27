# winvision: the Windows twin of tokvision, built-in WinRT APIs only (Windows 10/11, Windows PowerShell 5.1).
#
#   winvision.ps1 info  <image>...   JSON: size, OCR text, faces
#   winvision.ps1 ocr   <image>...   recognised text, one block per image
#   winvision.ps1 faces <image>...   JSON: face boxes (pixels, top-left origin)
#
# No person/subject cutout here: Windows has no built-in API for it (tokprep uses rembg when installed).
param([Parameter(Position = 0)][string]$Cmd, [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Paths)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.FaceAnalysis.FaceDetector, Windows.Media.FaceAnalysis, ContentType = WindowsRuntime] | Out-Null

function Load-Bitmap([string]$path) {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $path).Path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
}

$ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
function Read-Text($bitmap) {
    if (-not $ocr) { return @() }
    # the OCR engine refuses images past its maximum side: scale those down first
    $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($bitmap.PixelWidth -gt $max -or $bitmap.PixelHeight -gt $max) { return @('(image too large for Windows OCR)') }
    $result = Await ($ocr.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    @($result.Lines | ForEach-Object { $_.Text })
}

$detector = $null
function Find-Faces($bitmap) {
    if (-not [Windows.Media.FaceAnalysis.FaceDetector]::IsSupported) { return @() }
    if (-not $script:detector) { $script:detector = Await ([Windows.Media.FaceAnalysis.FaceDetector]::CreateAsync()) ([Windows.Media.FaceAnalysis.FaceDetector]) }
    $gray = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap, [Windows.Graphics.Imaging.BitmapPixelFormat]::Gray8)
    $listType = [System.Collections.Generic.IList``1].MakeGenericType([Windows.Media.FaceAnalysis.DetectedFace])
    $faces = Await ($script:detector.DetectFacesAsync($gray)) $listType
    @($faces | ForEach-Object { [ordered]@{ x = $_.FaceBox.X; y = $_.FaceBox.Y; w = $_.FaceBox.Width; h = $_.FaceBox.Height } } | Sort-Object { $_.x })
}

$out = @()
foreach ($p in $Paths) {
    try { $bmp = Load-Bitmap $p } catch { $out += [ordered]@{ path = $p; error = 'unreadable' }; continue }
    switch ($Cmd) {
        'ocr' {
            $lines = Read-Text $bmp
            Write-Output ("## {0} ({1}x{2})" -f [IO.Path]::GetFileName($p), $bmp.PixelWidth, $bmp.PixelHeight)
            Write-Output ($(if ($lines.Count) { $lines -join "`n" } else { '(no text)' }))
            Write-Output ''
        }
        'faces' { $out += [ordered]@{ path = $p; width = $bmp.PixelWidth; height = $bmp.PixelHeight; faces = @(Find-Faces $bmp) } }
        'info' { $out += [ordered]@{ path = $p; width = $bmp.PixelWidth; height = $bmp.PixelHeight; text = ((Read-Text $bmp) -join ' / '); faces = @(Find-Faces $bmp).Count; people = 0 } }
        default { Write-Error "usage: winvision.ps1 info|ocr|faces <image>..."; exit 2 }
    }
}
if ($Cmd -ne 'ocr') { ConvertTo-Json -InputObject @($out) -Depth 5 }
