Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('D:\Projects\SUNy\public\SUNy.png')
$w = $img.Width
$h = $img.Height
Write-Host "$w x $h"
$img.Dispose()
