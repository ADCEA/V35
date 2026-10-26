// Programme Windows (PowerShell) qui vient chercher, chaque soir, une sauvegarde fraîche du serveur et la range dans
// un dossier de l'ordinateur. Généré à la demande : il contient l'adresse du site et le jeton de cette installation.
//
//  • double exécution : lancé à la main (clic droit → « Exécuter avec PowerShell »), il s'installe — copie de lui-même
//    dans %LOCALAPPDATA%, tâche planifiée quotidienne — puis fait une première copie ;
//  • lancé par la tâche planifiée (-Run), il ne fait que la copie du soir ;
//  • il vérifie l'empreinte SHA-256 reçue du serveur avant de ranger le fichier, garde les 90 dernières copies et
//    tient un journal (journal.txt) dans le dossier de sauvegarde ;
//  • les messages sont en français ; le fichier est fourni avec BOM UTF-8 pour que PowerShell 5.1 lise les accents.

const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const TOKEN_RE = /^cz-[0-9a-f]{64}$/;

function buildScript({ origin, token }) {
  if (!ORIGIN_RE.test(origin || '')) throw new Error('Adresse du site invalide.');
  if (!TOKEN_RE.test(token || '')) throw new Error('Jeton invalide.');
  const body = String.raw`# Sauvegarde Blanchisserie Cézanne — copie de la base sur cet ordinateur, chaque soir.
# Ne partagez pas ce fichier : il contient la clé d'accès à vos sauvegardes (révocable depuis Facturation → Sécurité et sauvegardes).
param([switch]$Run)

$Site     = '@@ORIGIN@@'
$Jeton    = '@@TOKEN@@'
$Heure    = '22:00'
$Garder   = 90
$Nom      = 'Sauvegarde Blanchisserie Cezanne'
$Dossier  = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Sauvegardes Cezanne'
$Programme = Join-Path $env:LOCALAPPDATA 'BlanchisserieCezanne'
$Cible    = Join-Path $Programme 'sauvegarde-cezanne.ps1'
$Journal  = Join-Path $Dossier 'journal.txt'

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

function Ecrire($texte) {
  New-Item -ItemType Directory -Force -Path $Dossier | Out-Null
  Add-Content -Path $Journal -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $texte) -Encoding UTF8
}

function Copier {
  New-Item -ItemType Directory -Force -Path $Dossier | Out-Null
  $tmp = Join-Path $Dossier ('.reception-{0}.tmp' -f [guid]::NewGuid().ToString('N'))
  try {
    $r = Invoke-WebRequest -Uri ($Site + '/api/backup-pull/latest?fresh=1') -Headers @{ Authorization = 'Bearer ' + $Jeton } -UseBasicParsing -OutFile $tmp -PassThru -TimeoutSec 900
    $nom = [string]$r.Headers['X-Backup-Name']
    $attendu = ([string]$r.Headers['X-Backup-Sha256']).ToLower()
    if ($nom -notmatch '^cezanne-\d{8}T\d{6}Z\.sqlite\.gz\.enc$') { throw 'Nom de fichier reçu inattendu.' }
    $recu = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLower()
    if ($attendu -and $recu -ne $attendu) { throw 'Le fichier reçu est incomplet ou altéré (empreinte différente) : il n''a pas été conservé.' }
    $final = Join-Path $Dossier $nom
    Move-Item -Force -Path $tmp -Destination $final
    $ko = [math]::Max(1, [int]((Get-Item $final).Length / 1024))
    Ecrire ('Copie reçue : {0} ({1} Ko), empreinte vérifiée.' -f $nom, $ko)
    Get-ChildItem -Path $Dossier -Filter 'cezanne-*.sqlite.gz.enc' | Sort-Object Name -Descending | Select-Object -Skip $Garder | Remove-Item -Force
    return @{ ok = $true; message = ('Copie reçue : {0} ({1} Ko).' -f $nom, $ko) }
  } catch {
    $detail = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      try { $detail = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch { $detail = $_.ErrorDetails.Message }
    }
    Ecrire ('ÉCHEC : ' + $detail)
    return @{ ok = $false; message = $detail }
  } finally {
    if (Test-Path $tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
  }
}

if ($Run) {
  $res = Copier
  if (-not $res.ok) { exit 1 }
  exit 0
}

# --- installation (lancement à la main) ---
Write-Host ''
Write-Host 'Blanchisserie Cézanne — copie de sauvegarde chaque soir sur cet ordinateur' -ForegroundColor Cyan
Write-Host ''
try {
  New-Item -ItemType Directory -Force -Path $Programme | Out-Null
  if ($PSCommandPath -and ($PSCommandPath -ne $Cible)) { Copy-Item -Force -Path $PSCommandPath -Destination $Cible }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Run' -f $Cible)
  $declencheur = New-ScheduledTaskTrigger -Daily -At $Heure
  $options = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
  Register-ScheduledTask -TaskName $Nom -Action $action -Trigger $declencheur -Settings $options -Description 'Copie chaque soir la sauvegarde chiffrée de Blanchisserie Cézanne dans Documents\Sauvegardes Cezanne.' -Force | Out-Null
  Write-Host ('Installé : une copie sera faite chaque jour à {0} (au démarrage suivant si l''ordinateur est éteint).' -f $Heure) -ForegroundColor Green
} catch {
  Write-Host ('Installation impossible : ' + $_.Exception.Message) -ForegroundColor Red
  Read-Host 'Appuyez sur Entrée pour fermer'
  exit 1
}

Write-Host 'Première copie en cours…'
$res = Copier
if ($res.ok) {
  Write-Host $res.message -ForegroundColor Green
  Write-Host ('Dossier des copies : ' + $Dossier)
  Start-Process explorer.exe -ArgumentList ('"{0}"' -f $Dossier)
} else {
  Write-Host ('La première copie a échoué : ' + $res.message) -ForegroundColor Red
  Write-Host ('Détails dans : ' + $Journal)
}
Write-Host ''
Read-Host 'Appuyez sur Entrée pour fermer'
`;
  return '﻿' + body.replace('@@ORIGIN@@', origin).replace('@@TOKEN@@', token).replace(/\r?\n/g, '\r\n');
}

module.exports = { buildScript, ORIGIN_RE, TOKEN_RE };
