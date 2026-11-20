# 为只扫一层的宿主（如 DSH skill-filesystem）生成平层技能目录
# 用法: powershell -ExecutionPolicy Bypass -File mkflat.ps1 -Brain "D:\agent-brain"
param(
  [string]$Brain = "$env:USERPROFILE\agent-brain",
  [string]$Flat  = ""
)
if (-not $Flat) { $Flat = Join-Path $Brain ".brain\skills-flat" }
$skills = Join-Path $Brain "skills"
if (-not (Test-Path $skills)) { Write-Error "skills dir not found: $skills"; exit 1 }
New-Item -ItemType Directory -Force -Path $Flat | Out-Null
$count = 0
Get-ChildItem -Path $skills -Recurse -Filter SKILL.md -File | ForEach-Object {
  $name = Split-Path $_.DirectoryName -Leaf
  $target = Join-Path $Flat $name
  if (-not (Test-Path $target)) {
    New-Item -ItemType Junction -Path $target -Target $_.DirectoryName | Out-Null
    $count++
  }
}
Write-Host "linked $count skill(s) into $Flat"
