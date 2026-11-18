<#
.SYNOPSIS
  Copies the secrets in your local .env onto a Fly app.

.DESCRIPTION
  Run this yourself, from services/assistant-node. Values are piped to flyctl over stdin, so they
  never appear in the command line, the shell history or this script's output. Only key NAMES
  are printed. By default secrets are staged: they take effect on the next `fly deploy`.
  Use -Deploy to apply them to running machines straight away.

.EXAMPLE
  ./scripts/set-fly-secrets.ps1 -App assistant-node
  ./scripts/set-fly-secrets.ps1 -App assistant-node -Deploy
#>
param(
  [Parameter(Mandatory = $true)][string]$App,
  [string]$EnvFile = ".env",
  [switch]$Deploy
)

$ErrorActionPreference = "Stop"
$env:FLY_NO_UPDATE_CHECK = "1"   # stops flyctl's auto-upgrade prompt from failing the command

# Keys that must be present, and keys we never send (PORT is set in fly.toml).
$required = @("SUPABASE_JWT_ISSUER", "SUPABASE_DB_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")
$skip = @("PORT")

if (-not (Test-Path $EnvFile)) { throw "Cannot find $EnvFile. Copy .env.example to .env and fill it in first." }

$pairs = [ordered]@{}
foreach ($line in Get-Content $EnvFile) {
  $trimmed = $line.Trim()
  if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
  $index = $trimmed.IndexOf("=")
  if ($index -lt 1) { continue }
  $key = $trimmed.Substring(0, $index).Trim()
  $value = $trimmed.Substring($index + 1).Trim().Trim('"').Trim("'")
  if ($skip -contains $key -or $value -eq "") { continue }
  $pairs[$key] = $value
}

$missing = $required | Where-Object { -not $pairs.Contains($_) }
if ($missing) { throw "Missing in ${EnvFile}: $($missing -join ', ')" }

Write-Host "App: $App"
Write-Host "Secrets to set: $($pairs.Keys -join ', ')"
if (-not $Deploy) { Write-Host "Mode: staged (applied on the next fly deploy)" } else { Write-Host "Mode: apply now" }
$answer = Read-Host "Continue? (y/N)"
if ($answer -ne "y") { Write-Host "Cancelled."; exit 0 }

$body = ($pairs.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n"
$flyArgs = @("secrets", "import", "-a", $App)
if (-not $Deploy) { $flyArgs += "--stage" }

$body | & fly @flyArgs
if ($LASTEXITCODE -ne 0) { throw "flyctl failed with exit code $LASTEXITCODE" }
Write-Host "Done. Check names with: fly secrets list -a $App"
