<#
.SYNOPSIS
  Builds CountryDropdownPCF and packages it into a Dataverse solution.

.EXAMPLE
  .\scripts\Build-Solution.ps1 -PublisherName "Talha" -PublisherPrefix "tal" -PackageType Both

  Output (Solution\CountrySelector\bin\Release):
    CountrySelector.zip            unmanaged
    CountrySelector_managed.zip    managed
#>
[CmdletBinding()]
param(
    [string]$PublisherName = "Talha",
    [ValidatePattern('^[a-z][a-z0-9]{1,7}$')]
    [string]$PublisherPrefix = "tal",
    [ValidatePattern('^[A-Za-z][A-Za-z0-9_]*$')]
    [string]$SolutionName = "CountrySelector",
    [ValidateSet("Unmanaged", "Managed", "Both")]
    [string]$PackageType = "Both"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "==> Installing npm dependencies" -ForegroundColor Cyan
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

Write-Host "==> Production build" -ForegroundColor Cyan
npm run build:prod
if ($LASTEXITCODE -ne 0) { throw "PCF build failed" }

$solutionDir = Join-Path (Join-Path $root "Solution") $SolutionName
$cdsproj = Join-Path $solutionDir "$SolutionName.cdsproj"

if (-not (Test-Path $cdsproj)) {
    Write-Host "==> Creating solution project $SolutionName" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $solutionDir | Out-Null
    Push-Location $solutionDir
    try {
        pac solution init --publisher-name $PublisherName --publisher-prefix $PublisherPrefix
        if ($LASTEXITCODE -ne 0) { throw "pac solution init failed" }
        pac solution add-reference --path $root
        if ($LASTEXITCODE -ne 0) { throw "pac solution add-reference failed" }
    }
    finally { Pop-Location }
}

# Set the package type (Unmanaged / Managed / Both) in the .cdsproj
[xml]$xml = Get-Content $cdsproj
$ns = $xml.Project.NamespaceURI
$node = $xml.SelectSingleNode("//*[local-name()='SolutionPackageType']")
if (-not $node) {
    $pg = $xml.CreateElement("PropertyGroup", $ns)
    $node = $xml.CreateElement("SolutionPackageType", $ns)
    [void]$pg.AppendChild($node)
    [void]$xml.Project.AppendChild($pg)
}
$node.InnerText = $PackageType
$xml.Save($cdsproj)

Write-Host "==> Building solution ($PackageType)" -ForegroundColor Cyan
Push-Location $solutionDir
try {
    dotnet build --configuration Release
    if ($LASTEXITCODE -ne 0) { throw "Solution build failed" }
}
finally { Pop-Location }

Get-ChildItem (Join-Path $solutionDir "bin\Release") -Filter *.zip | ForEach-Object {
    Write-Host "Built: $($_.FullName)" -ForegroundColor Green
}
