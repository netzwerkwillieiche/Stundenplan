# Baut stundenplan-deploy.zip fuer das VNW-Node-Apps-Deploy.
# Bewusst NICHT Compress-Archive: das schreibt Pfade mit Backslash in den ZIP-Index, woraus auf
# einem Linux-Zielserver Dateien namens "public\app.js" statt eines public/-Ordners werden.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$out = Join-Path $root 'stundenplan-deploy.zip'

# Explizite Liste statt Ordner-Scan: node_modules und stundenplan.db duerfen nie ins Paket.
$files = @(
  'package.json', 'package-lock.json', 'README.md',
  'db.js', 'index.js', 'icon.js', 'untis.js', 'iserv.js', 'ical.js', 'netz.js', 'rss.js', 'vnw.js',
  'push.js', 'test.js',
  'public/index.html', 'public/style.css',
  'public/manifest.webmanifest', 'public/sw.js',
  'public/app.js', 'public/start.js', 'public/kern.js', 'public/login.js', 'public/plan.js',
  'public/freunde.js', 'public/chat.js', 'public/hausaufgaben.js', 'public/kalender.js', 'public/raumplan.js',
  'public/menue.js', 'public/buero.js', 'public/freigabe.js', 'public/umfragen.js', 'public/umfrage-logik.js',
  'buero.js',
  'public/profil.js',
  'public/admin.js', 'public/tickets.js', 'public/emoji.js'
)

Add-Type -AssemblyName System.IO.Compression.FileSystem
Remove-Item -Force -ErrorAction SilentlyContinue $out
$zip = [IO.Compression.ZipFile]::Open($out, 'Create')
try {
  foreach ($rel in $files) {
    $src = Join-Path $root ($rel -replace '/', '\')
    if (-not (Test-Path $src)) { throw "Datei fehlt: $rel" }
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $src, $rel, 'Optimal')
  }
} finally {
  $zip.Dispose()
}

$kb = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host "stundenplan-deploy.zip  -  $($files.Count) Dateien, $kb KB"
