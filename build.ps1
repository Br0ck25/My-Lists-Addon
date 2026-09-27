# build.ps1 — Rebuilds worker_entry_combined.js from the numbered split files.
# Run this any time you edit a split file:  .\build.ps1

$dir    = $PSScriptRoot
$output = Join-Path $dir "worker_entry_combined.js"

# The header comes from header.js, exactly as build.py reads it, so the two
# build scripts cannot drift apart (this used to be a separate inline copy).
$header = [System.IO.File]::ReadAllText((Join-Path $dir "header.js"), (New-Object System.Text.UTF8Encoding($false)))

# Gather split files in numeric order (00_ ... 26_), exclude the combined output itself.
$parts = Get-ChildItem -Path $dir -Filter "*.js" |
         Where-Object { $_.Name -match '^\d{2}_' } |
         Sort-Object Name

if (-not $parts) {
    Write-Error "No numbered split files found in $dir"
    exit 1
}

Write-Host "Building worker_entry_combined.js from $($parts.Count) files..."

# Write header then append each split file (UTF-8 no BOM).
$encoding = New-Object System.Text.UTF8Encoding($false)  # $false = no BOM
$writer   = [System.IO.StreamWriter]::new($output, $false, $encoding)
# LF, always. WriteLine() below defaults to Environment.NewLine, which is
# CRLF on Windows -- that would put a stray CRLF into an otherwise-LF file
# and make this script disagree with build.py byte-for-byte. See
# .gitattributes for why the whole repository is pinned to LF.
$writer.NewLine = "`n"

try {
    $writer.Write($header)

    foreach ($part in $parts) {
        Write-Host "  + $($part.Name)"
        $content = [System.IO.File]::ReadAllText($part.FullName, $encoding)
        $writer.Write($content)
        # Ensure each file ends with a newline before the next one begins.
        if (-not $content.EndsWith("`n")) {
            $writer.WriteLine()
        }
    }
} finally {
    $writer.Close()
}

$lineCount = (Get-Content $output).Count
$sizeKB    = [Math]::Round((Get-Item $output).Length / 1KB, 1)
Write-Host ""
Write-Host "Done!  worker_entry_combined.js  ($lineCount lines, $sizeKB KB)" -ForegroundColor Green
