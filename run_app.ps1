$env:ELECTRON_RUN_AS_NODE = $null
$port = 5173
$conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
if ($conn) {
    Write-Host "Killing processes on port $port..."
    $conn | Select-Object -ExpandProperty OwningProcess | ForEach-Object { 
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue 
    }
}

Write-Host "Kiling any existing ALT+Space or Electron processes..."
Get-Process | Where-Object { $_.ProcessName -match "ALT\+Space" -or $_.ProcessName -match "electron" } | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2

Write-Host "Starting npm run dev..."
npm run dev
