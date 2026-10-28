[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')]
    [string]$Profile = 'zeta-test',
    [string]$Package,
    [string]$Source,
    [string]$DesktopExe,
    [switch]$InspectOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$inspector = Join-Path $PSScriptRoot 'inspect-local-runtime.cjs'

function Assert-ChildPath([string]$Root, [string]$Candidate) {
    $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $normalizedCandidate = [IO.Path]::GetFullPath($Candidate)
    if (-not $normalizedCandidate.StartsWith($normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the intended directory: $normalizedCandidate"
    }
    return $normalizedCandidate
}

function Invoke-DshProcess([string]$Executable, [string[]]$Arguments) {
    # Electron is a GUI-subsystem executable on Windows. PowerShell's call
    # operator may return before it exits and leave LASTEXITCODE unchanged.
    $processInfo = [Diagnostics.ProcessStartInfo]::new()
    $processInfo.FileName = $Executable
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $processInfo.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $processInfo
    try {
        if (-not $process.Start()) { throw 'DSH process did not start.' }
        $standardOutput = $process.StandardOutput.ReadToEndAsync()
        $standardError = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $outputText = $standardOutput.GetAwaiter().GetResult()
        $errorText = $standardError.GetAwaiter().GetResult()
        if ($outputText) { Write-Host $outputText.TrimEnd() }
        if ($errorText) { Write-Host $errorText.TrimEnd() }
        return $process.ExitCode
    } finally {
        $process.Dispose()
    }
}

$inspectArgs = @($inspector)
if ($DesktopExe) { $inspectArgs += @('--desktop-exe', $DesktopExe) }
$runtimeJson = & node @inspectArgs
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the local DSH runtime.' }
$runtime = ($runtimeJson -join "`n") | ConvertFrom-Json
if ($InspectOnly) {
    $runtime | ConvertTo-Json -Depth 4
    return
}

if ($Package -and $Source) { throw 'Use either -Package <local.tgz> or -Source <GitHub repository>, not both.' }
$packagePath = $null
if ($Source) {
    if ($Source -notmatch '^(?:github:|(?:git\+)?https://github\.com/)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:#[^\s]+)?$') {
        throw 'Source must be github:owner/repository[#ref] or an HTTPS GitHub repository URL.'
    }
    $installTarget = $Source
} else {
    if (-not $Package) {
        $candidates = foreach ($directory in @($projectRoot, (Join-Path $projectRoot 'release'), (Join-Path $projectRoot 'artifacts'), (Join-Path $projectRoot 'dist'))) {
            if (Test-Path -LiteralPath $directory -PathType Container) {
                Get-ChildItem -LiteralPath $directory -File -Filter '*.tgz'
            }
        }
        $latest = $candidates | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        if (-not $latest) { throw 'No local .tgz package found. Build and pack the plugin, then pass -Package <absolute-path.tgz>.' }
        $Package = $latest.FullName
    }
    $packagePath = (Resolve-Path -LiteralPath $Package).Path
    if ([IO.Path]::GetExtension($packagePath) -ne '.tgz' -or -not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
        throw 'Package must name an existing local .tgz file.'
    }
    $installTarget = $packagePath
}
$harnessRoot = [IO.Path]::GetFullPath([string]$runtime.harnessHome)
$profilesRoot = Join-Path $harnessRoot 'profiles'
$profilePath = Assert-ChildPath $profilesRoot (Join-Path $profilesRoot $Profile)
$backupRoot = Join-Path $projectRoot 'output\local-install-backups'
$stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')
$backupPath = Assert-ChildPath $backupRoot (Join-Path $backupRoot "$stamp-$Profile")
$initializesWebTemplate = $Profile -notin @('desktop', 'web', 'acp', 'headless', 'sdk', 'sdk-minimal') -and -not (Test-Path -LiteralPath (Join-Path $profilePath 'package.json') -PathType Leaf)

$plan = [ordered]@{
    profile = $Profile
    profilePath = $profilePath
    package = $packagePath
    source = $(if ($Source) { $Source } else { $null })
    runtimeVersion = $runtime.runtimeVersion
    backupPath = $backupPath
    restartsDesktop = $false
    initializesWebTemplate = $initializesWebTemplate
}
if (-not $PSCmdlet.ShouldProcess($profilePath, 'Back up existing profile configuration and install Zeta with the official DSH CLI')) {
    $plan | ConvertTo-Json
    return
}

# These files may contain private settings. Copy them without printing their contents.
# node_modules and conversation/credential stores are deliberately left in place.
New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
$existed = Test-Path -LiteralPath $profilePath -PathType Container
if ($existed) {
    foreach ($file in @('package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc')) {
        $source = Join-Path $profilePath $file
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $backupPath $file)
        }
    }
    $managerPath = Join-Path $profilePath '.plugin-manager'
    if (Test-Path -LiteralPath $managerPath -PathType Container) {
        Copy-Item -LiteralPath $managerPath -Destination (Join-Path $backupPath '.plugin-manager') -Recurse
    }
}
$plan.profilePreviouslyExisted = $existed
$plan | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupPath 'install-plan.json') -Encoding utf8NoBOM

$savedEnvironment = @{}
foreach ($name in @('ELECTRON_RUN_AS_NODE', 'DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'ZETA_DSH_CLI_PATH', 'ZETA_DSH_BOOT_PATH', 'ZETA_DSH_PROFILE_PATH', 'ZETA_DSH_PNPM_ENTRY', 'ZETA_DSH_RUNTIME_BIN')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $env:DSH_HOME = $harnessRoot
    $env:DSH_TELEMETRY_DISABLED = '1'
    if ($initializesWebTemplate) {
        # Unknown profile names otherwise initialize only dsh-base, which has
        # no Web SessionController/Schedule. The public initializer writes
        # missing files only and selects the shipped Web composition.
        $env:ZETA_DSH_BOOT_PATH = Join-Path ([string]$runtime.moduleRoot) 'dsh-app-boot\lib\index.js'
        $env:ZETA_DSH_PROFILE_PATH = $profilePath
        $initializeEntry = 'import(require("node:url").pathToFileURL(process.env.ZETA_DSH_BOOT_PATH).href).then(m=>m.initProfile(process.env.ZETA_DSH_PROFILE_PATH,m.PROFILE_TEMPLATES.web.bundles)).catch(e=>{console.error(e.message);process.exitCode=1})'
        $initializeExitCode = Invoke-DshProcess ([string]$runtime.executable) @('-e', $initializeEntry)
        if ($initializeExitCode -ne 0) { throw "DSH Web test profile initialization failed (exit $initializeExitCode). Configuration backup: $backupPath" }
    }
    $cliArgs = @([string]$runtime.cliPath, 'plugin', '--profile', $Profile, 'add', $installTarget)
    if ($Profile -eq 'desktop') {
        # rc.3 reserves desktop for its installed carrier. Use the carrier's
        # official CLI and package-manager options. Its bundled pnpm must match
        # the existing profile store; an unrelated pnpm on PATH may not.
        $env:ZETA_DSH_CLI_PATH = [string]$runtime.cliPath
        $desktopResources = Join-Path (Split-Path -Parent ([string]$runtime.executable)) 'resources'
        $env:ZETA_DSH_PNPM_ENTRY = Join-Path $desktopResources 'runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
        $env:ZETA_DSH_RUNTIME_BIN = Join-Path $desktopResources 'runtime\bin'
        if (-not (Test-Path -LiteralPath $env:ZETA_DSH_PNPM_ENTRY -PathType Leaf)) { throw 'Desktop bundled pnpm was not found; refusing to substitute a different package-manager version.' }
        $desktopEntry = 'process.argv.splice(1,0,process.env.ZETA_DSH_CLI_PATH); import(require("node:url").pathToFileURL(process.env.ZETA_DSH_CLI_PATH).href).then(m=>m.runCli({manageDesktopProfile:true,packageManager:{command:process.execPath,args:["--expose-internals",process.env.ZETA_DSH_PNPM_ENTRY],env:{ELECTRON_RUN_AS_NODE:"1",DSH_DESKTOP_NODE_EXECUTABLE:process.execPath,PATH:process.env.ZETA_DSH_RUNTIME_BIN+require("node:path").delimiter+process.env.PATH}}})).catch(e=>{console.error(e.message);process.exitCode=1})'
        $cliArgs = @('-e', $desktopEntry, '--', 'plugin', '--profile', $Profile, 'add', $installTarget)
    }
    $installExitCode = Invoke-DshProcess ([string]$runtime.executable) $cliArgs
    if ($installExitCode -ne 0) { throw "DSH plugin installation failed (exit $installExitCode). Configuration backup: $backupPath" }
    Write-Output "Installed into DSH profile '$Profile'. Existing configuration backup: $backupPath"
    Write-Output 'The running Desktop was not restarted. A reload/restart may be needed before it loads the package.'
} finally {
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}
