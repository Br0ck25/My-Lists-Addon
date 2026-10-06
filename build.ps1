# build.ps1 -- Rebuilds worker_entry_combined.js from the numbered split files.
# Run this any time you edit a split file:  .\build.ps1
#
# This used to be a second implementation of the build. It now runs build.py, so
# there is one build and the two can never produce different bytes (CI rebuilds
# with build.py and fails on any difference, and build.py also fills in the
# build stamp /admin shows). Python 3 is required either way.
$dir = $PSScriptRoot
Push-Location $dir
try {
    $py = Get-Command python3 -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
    if (-not $py) {
        Write-Error "Python 3 was not found. Install it, then run: python build.py"
        exit 1
    }
    & $py.Source build.py
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
