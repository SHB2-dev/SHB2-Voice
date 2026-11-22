# SHB2 読み上げBOT①〜⑥ のアイコン(512x512 PNG)を生成する: powershell -File make-icons.ps1
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot 'icons'
New-Item -ItemType Directory -Force $out | Out-Null

$colors = @(
  @('#6366F1', '#A5B4FC'), # 1 indigo
  @('#10B981', '#6EE7B7'), # 2 green
  @('#F59E0B', '#FCD34D'), # 3 amber
  @('#EF4444', '#FCA5A5'), # 4 red
  @('#EC4899', '#F9A8D4'), # 5 pink
  @('#0EA5E9', '#7DD3FC')  # 6 sky
)
$S = 512

function C($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }

for ($n = 1; $n -le 6; $n++) {
  $bmp = New-Object System.Drawing.Bitmap $S, $S
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)

  $main = [System.Drawing.ColorTranslator]::FromHtml($colors[$n - 1][0])
  $light = [System.Drawing.ColorTranslator]::FromHtml($colors[$n - 1][1])

  # 背景: グラデーションの円
  $rect = [System.Drawing.Rectangle]::new(0, 0, $S, $S)
  $grad = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, [System.Drawing.Color]$light, [System.Drawing.Color]$main, [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
  $g.FillEllipse($grad, 0, 0, ($S - 1), ($S - 1))

  # 吹き出し (白): 角丸四角 + しっぽ
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $x = 96; $y = 108; $w = 320; $h = 230; $r = 56
  $path.AddArc($x, $y, $r, $r, 180, 90)
  $path.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
  $path.AddArc($x + $w - $r, $y + $h - $r, $r, $r, 0, 90)
  $path.AddLine($x + 200, $y + $h, $x + 130, $y + $h + 70)   # しっぽ
  $path.AddLine($x + 130, $y + $h + 70, $x + 120, $y + $h)
  $path.AddArc($x, $y + $h - $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $g.FillPath($white, $path)

  # 番号
  $font = New-Object System.Drawing.Font 'Segoe UI', 150, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $numRect = New-Object System.Drawing.RectangleF $x, ($y - 6), $w, $h
  $g.DrawString("$n", $font, (New-Object System.Drawing.SolidBrush $main), $numRect, $sf)

  # 音波 (右下)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 14
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $g.DrawArc($pen, 300, 330, 60, 60, -50, 100)
  $g.DrawArc($pen, 280, 310, 100, 100, -50, 100)
  $g.DrawArc($pen, 260, 290, 140, 140, -50, 100)

  # SHB2 ラベル
  $small = New-Object System.Drawing.Font 'Segoe UI', 52, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $lab = New-Object System.Drawing.RectangleF 0, 420, $S, 70
  $g.DrawString('SHB2', $small, $white, $lab, $sf)

  $file = Join-Path $out ("SHB2-yomiage-bot-{0}.png" -f $n)
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output $file
}
