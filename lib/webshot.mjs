// webshot — render a page in headless Edge/Chrome at several widths and write
// a layout report + screenshots, with no npm dependencies (Node 22 WebSocket + CDP).
//
//   node webshot.mjs <url|file.html> <outdir> [--widths 1440,390] [--select "#about"] [--wait 1500]
//
// Writes <outdir>/report.json and <outdir>/shot-<width>[-<n>].png
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d }
const widths = opt('--widths', '1440,390').split(',').map(Number)
const select = opt('--select', '')
const wait = Number(opt('--wait', '1200'))
const [target, outdir] = argv
if (!target || !outdir) { console.error('usage: webshot.mjs <url|file> <outdir> [--widths] [--select] [--wait]'); process.exit(2) }
const url = /^[a-z]+:\/\//.test(target) ? target : pathToFileURL(resolve(target.split('#')[0])).href + (target.includes('#') ? '#' + target.split('#')[1] : '')
mkdirSync(outdir, { recursive: true })

const env = process.env
const BROWSERS = [
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Windows
  ...[env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).flatMap(dir => [
    join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(dir, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ]),
  // Linux
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
]
const exe = process.env.TOKPREP_BROWSER || BROWSERS.find(existsSync)
if (!exe) { console.error('no Chromium-based browser found; set TOKPREP_BROWSER'); process.exit(1) }
const profile = mkdtempSync(join(tmpdir(), 'tokprep-'))
const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--allow-file-access-from-files', '--hide-scrollbars', '--mute-audio', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port
for (let i = 0; i < 100 && !port; i++) {
  await sleep(100)
  try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch {}
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))
let seq = 0; const pending = new Map(); const problems = []
ws.addEventListener('message', ({ data }) => {
  const m = JSON.parse(data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0])
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`console.${m.params.type}: ` + m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 200))
  if (m.method === 'Network.loadingFailed' && !m.params.canceled) problems.push(`failed load (${m.params.errorText}): ${m.params.requestId}`)
  if (m.method === 'Network.requestWillBeSent') reqs.set(m.params.requestId, m.params.request.url)
})
const reqs = new Map()
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expr => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value

// The element that actually scrolls: the document, or an inner panel when the body is overflow:hidden.
const SCROLLER = `(window.__tpS ||= (() => {
  const can = el => { const t = el.scrollTop; el.scrollTop = t + 5; const ok = el.scrollTop !== t; el.scrollTop = t; return ok }
  const doc = document.scrollingElement
  if (can(doc)) return doc
  return [...document.querySelectorAll('*')].filter(el => el.clientHeight > innerHeight * .5 && el.scrollHeight > el.clientHeight + 50 && can(el))
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || doc
})())`

// Runs inside the page: the facts a screenshot is usually taken to check.
const PROBE = sel => `(() => {
  const vw = innerWidth, de = document.documentElement, S = ${SCROLLER}
  const desc = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '')
  const visible = el => el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  const all = [...document.body.querySelectorAll('*')]
  const overflow = all.filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > vw + 1 && visible(el) && getComputedStyle(el).position !== 'fixed' })
    .filter((el, _, arr) => !arr.includes(el.parentElement)).slice(0, 8)
    .map(el => desc(el) + ' right=' + Math.round(el.getBoundingClientRect().right))
  const imgs = [...document.images]
  const broken = imgs.filter(i => i.complete && i.naturalWidth === 0 && i.currentSrc).map(i => i.currentSrc.split('/').pop()).slice(0, 8)
  const heavy = imgs.filter(i => i.naturalWidth > 2.5 * i.clientWidth * devicePixelRatio && i.clientWidth > 40).map(i => i.currentSrc.split('/').pop() + ' ' + i.naturalWidth + 'px shown at ' + i.clientWidth + 'px').slice(0, 6)
  const tiny = all.filter(el => el.childNodes.length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && visible(el) && parseFloat(getComputedStyle(el).fontSize) < 11)
    .slice(0, 6).map(el => desc(el) + ' ' + getComputedStyle(el).fontSize)
  const outline = [...document.querySelectorAll('h1,h2,h3,section[id],[id].section')].filter(visible).slice(0, 30)
    .map(el => ({ tag: el.tagName.toLowerCase(), id: el.id, text: (el.innerText || '').trim().slice(0, 60), y: Math.round(el.getBoundingClientRect().top + S.scrollTop) }))
  const r = { viewport: vw + 'x' + innerHeight, pageHeight: S.scrollHeight, scroller: S === document.scrollingElement ? 'document' : desc(S), horizontalScroll: de.scrollWidth > vw ? de.scrollWidth - vw + 'px' : 'none',
              overflow, broken, heavy, tiny, outline, title: document.title }
  ${sel ? `const el = document.querySelector(${JSON.stringify(sel)})
  if (el) { el.scrollIntoView({ block: 'start' }); const b = el.getBoundingClientRect(), s = getComputedStyle(el)
    r.selected = { selector: ${JSON.stringify(sel)}, x: Math.round(b.left), y: Math.round(b.top + S.scrollTop), top: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height),
      font: s.fontSize + ' ' + s.fontFamily.split(',')[0], color: s.color, background: s.backgroundColor, text: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 600) } }
  else r.selected = { selector: ${JSON.stringify(sel)}, missing: true }` : ''}
  return r
})()`

await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable'].map(m => cdp(m)))
const report = { url, select, widths: [] }
for (const w of widths) {
  problems.length = 0
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: w < 700 ? 844 : 900, deviceScaleFactor: 1, mobile: w < 700 })
  const loaded = new Promise(r => { const f = ({ data }) => { if (JSON.parse(data).method === 'Page.loadEventFired') { ws.removeEventListener('message', f); r() } }; ws.addEventListener('message', f) })
  await cdp('Page.navigate', { url })
  await Promise.race([loaded, sleep(15000)])
  // scroll through once so lazy images and reveal-on-scroll content load, then back to top
  await evaluate(`(async () => { const S = ${SCROLLER}; for (let y = 0; y < S.scrollHeight; y += innerHeight) { S.scrollTop = y; await new Promise(r => setTimeout(r, 120)) } S.scrollTop = 0 })()`)
  await sleep(wait)
  const r = await evaluate(PROBE(select))
  r.problems = [...new Set(problems.map(p => p.replace(/failed load \((.*)\): (\S+)/, (_, e, id) => `failed load (${e}): ${(reqs.get(id) || id).split('/').pop()}`)))].slice(0, 10)
  // screenshots: the selected element, or the page cut into at most 4 viewport-high slices
  const shots = []
  const clipH = w < 700 ? 844 : 900
  const n = Math.min(4, Math.ceil(r.pageHeight / clipH))
  // each slice: scroll the real scroller there, then capture the viewport (works for inner scroll panels too)
  const sel = r.selected && !r.selected.missing && r.selected
  const clips = sel
    ? [{ scroll: Math.max(0, sel.y - 40), x: 0, y: 0, width: w, height: Math.min(sel.h + 80, clipH) }]
    : Array.from({ length: n }, (_, i) => ({ scroll: n > 1 ? Math.round(i * (r.pageHeight - clipH) / (n - 1)) : 0, x: 0, y: 0, width: w, height: clipH }))
  for (const [i, { scroll, ...c }] of clips.entries()) {
    await evaluate(`${SCROLLER}.scrollTop = ${scroll}`); await sleep(300)
    c.y = 0; c.y = scroll
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...c, y: 0, scale: 1 } })
    const file = join(outdir, `shot-${w}${clips.length > 1 ? '-' + (i + 1) : ''}.png`)
    writeFileSync(file, Buffer.from(data, 'base64')); shots.push({ file, label: `${w}px y=${c.y}` })
  }
  report.widths.push({ width: w, ...r, shots })
}
writeFileSync(join(outdir, 'report.json'), JSON.stringify(report, null, 1))
ws.close(); proc.kill(); await sleep(300); rmSync(profile, { recursive: true, force: true })
console.log(join(outdir, 'report.json'))
