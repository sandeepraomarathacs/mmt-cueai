/**
 * Free Vite port + close previous Electron instances from this desktop app
 * so `npm run dev` can start cleanly.
 */
import { execFileSync, execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 5174
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const marker = path.join(root, 'node_modules', 'electron').toLowerCase()

function uniq(ids) {
  return [...new Set(ids.map(String).filter((id) => /^\d+$/.test(id) && id !== '0'))]
}

function killPids(pids, label) {
  for (const pid of uniq(pids)) {
    try {
      if (isWin) {
        execFileSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore' })
      } else {
        process.kill(Number(pid), 'SIGTERM')
      }
      console.log(`[free-dev] stopped ${label} pid=${pid}`)
    } catch {
      // already gone
    }
  }
}

function pidsOnPort(port) {
  try {
    if (isWin) {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
      const pids = []
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue
        const parts = line.trim().split(/\s+/)
        pids.push(parts[parts.length - 1])
      }
      return pids
    }

    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN || true`, {
      encoding: 'utf8',
      shell: '/bin/bash',
    })
    return out.split(/\s+/).filter(Boolean)
  } catch {
    return []
  }
}

function electronPidsForThisApp() {
  try {
    if (isWin) {
      const ps = `
$marker = '${marker.replace(/'/g, "''")}'
Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
  Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.ToLower().Contains($marker)
  } |
  Select-Object -ExpandProperty ProcessId
`
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', ps],
        { encoding: 'utf8' },
      )
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    }

    const out = execSync("pgrep -af '[e]lectron' || true", {
      encoding: 'utf8',
      shell: '/bin/bash',
    })
    return out
      .split(/\r?\n/)
      .filter((line) => line.toLowerCase().includes(marker))
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean)
  } catch {
    return []
  }
}

killPids(pidsOnPort(PORT), `port ${PORT}`)
killPids(electronPidsForThisApp(), 'electron')
console.log('[free-dev] ready')
