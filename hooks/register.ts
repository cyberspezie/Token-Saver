import type { EngineInterface, Register } from 'claude-code'

const IMAGE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i
const VIDEO = /\.(mp4|mov|m4v|avi|mkv|webm)$/i
const SCREENSHOT = /(screenshot|schermata|istantanea|screen shot|CleanShot)/i
const BIG_TEXT = 60_000        // bytes, about 17k tokens: past this a whole-file Read gets the outline first
const LONG_LINE = 500          // shell output lines longer than this are clipped...
const CLIP = 240               // ...to this many characters
const RAW = /TOKPREP_RAW=1/    // a command carrying this keeps its output whole
// `find` over the whole home folder (or /): Spotlight answers the same in a second, as a short list
const HOME_FIND = /^\s*find\s+(~|\$HOME|\/Users\/[^/\s]+|\/)\/?\s/
// a message that sounds like a final yes (Italian or English), and words that undo it
const APPROVAL = /\b(ok(ay)?|perfett\w*|approv\w*|va bene|mi piace|ottim\w*|bellissim\w*|definitiv\w*|fatto|consegna\w*|così va|looks good|perfect|approved|ship it|love it|great)\b/i
const NOT_YET = /\b(non|not|no|ancora|cambia\w*|modific\w*|rifai|prova(re)?|but|ma)\b/i
const COMPACT_AT = 30          // after a job is done, compact the conversation when the context is at least this % full

// A path or command is nudged once: if Claude does it again, it really needs it, and it goes through.
const nudged = new Set<string>()
let jobLine: string | undefined            // "job <name> · 12 MB temporary · 0 final(s)" while a job is open
let finished: { name: string; freed: string } | undefined

// Windows installs have a drive-letter root: there tokprep runs through Python, elsewhere the script runs itself.
const isWindows = (root: string) => /^[A-Za-z]:[\\/]/.test(root)
const tokprep = (root: string) => isWindows(root) ? `python "${root}\\bin\\tokprep"` : `"${root}/bin/tokprep"`
const FALLBACK = 'If tokprep answers NOT AVAILABLE on this machine, do it directly as you would without it.'

// The open job, as one line, from tokprep itself (it owns the job files). The mod draws no status line or notices.
async function refreshJob($: EngineInterface) {
  const script = isWindows($.plugin.root) ? `${$.plugin.root}\\bin\\tokprep` : `${$.plugin.root}/bin/tokprep`
  const pythons = isWindows($.plugin.root) ? [['py', '-3'], ['python']] : [['/usr/bin/python3', '-I'], ['python3']]
  let line: string | undefined
  for (const py of pythons) {
    const r = await $.process.run([...py, script, 'job', 'status', '--line']).catch(() => undefined)
    if (r && r.exitCode === 0) { line = r.stdout.trim(); break }
  }
  jobLine = line && line.startsWith('job ') ? line : undefined
}

export const register: Register = on => {

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { ...composed, sections: [...composed.sections, { id: 'token-saver:command', scope: 'session' as const,
      text: `Local media/file prep on this machine: ${tokprep($.plugin.root)} <command> (see the token-saver skill). ${FALLBACK}` }] }
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refreshJob($)
    return started
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const path = e.file_path
    if (path.includes('/tokprep/') || nudged.has(path)) return next(e)
    const again = 'Reading this same file again goes through.'

    if (IMAGE.test(path)) {
      nudged.add(path)
      const hint = SCREENSHOT.test(path)
        ? `${tokprep($.plugin.root)} ocr "${path}" gives its text`
        : `${tokprep($.plugin.root)} media "${path}" gives size, text, faces and people plus a contact sheet (pass several files or a folder at once)`
      return { deny: `Prep it locally first: ${hint}. Other local tools: faces, cutout, key, asset (edits). ` +
        `For a web page: ${tokprep($.plugin.root)} web <url|file.html#anchor> [--select CSS]. ${FALLBACK} ${again}` }
    }
    if (VIDEO.test(path)) {
      nudged.add(path)
      return { deny: `Prep video locally first: ${tokprep($.plugin.root)} scenes "${path}" (one frame per scene change on one sheet, cut list, on-screen text) ` +
        `or ${tokprep($.plugin.root)} media "${path}" (adds the Whisper transcript). Read the summary.md it prints. ${FALLBACK} ${again}` }
    }
    if (e.offset === undefined && e.limit === undefined && e.pages === undefined) {
      const st = await $.fs.stat(path).catch(() => undefined)
      if (st?.kind === 'file' && st.size > BIG_TEXT) {
        nudged.add(path)
        return { deny: `${path} is ${Math.round(st.size / 1024)} KB (≈${Math.round(st.size / 3600)}k tokens). ` +
          `Run ${tokprep($.plugin.root)} file "${path}" for a one-page outline, then Read with offset/limit or ${tokprep($.plugin.root)} peek "${path}" <start> <end>. ${FALLBACK} Reading it whole again goes through.` }
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))   // a guard that fails lets the call through: saving tokens never blocks work

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (HOME_FIND.test(e.command) && !nudged.has(e.command)) {
      nudged.add(e.command)
      return { deny: `A find over the whole home folder is slow and its output long. ` +
        `${tokprep($.plugin.root)} find <words> [--kind image|video|pdf|doc|code|folder] [--days N] [--name] [--in dir] asks Spotlight / Windows Search and prints a short grouped list. ${FALLBACK} ` +
        `Running the same find again goes through.` }
    }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const out = ran.result.stdout ?? ''

    // a job opened, changed or closed: refresh the status line; a closed job asks for a compaction at turn end
    if (/tokprep/.test(e.command) && /\bjob\b|\basset\b|\bcutout\b|\bkey\b/.test(e.command)) {
      const done = out.match(/TOKPREP_JOB_DONE name=("(?:[^"\\]|\\.)*") freed=(\d+)/)
      if (done) finished = { name: JSON.parse(done[1] ?? '"job"'), freed: `${(Number(done[2] ?? 0) / 1048576).toFixed(1)} MB` }
      await refreshJob($)
    }

    if (RAW.test(e.command) || out.length < LONG_LINE) return ran
    let cut = 0
    const clipped = out.split('\n').map(l => {
      if (l.length <= LONG_LINE) return l
      cut += l.length - CLIP
      return `${l.slice(0, CLIP)} …[+${(l.length - CLIP).toLocaleString()} chars clipped; prefix TOKPREP_RAW=1 to see all]`
    }).join('\n')
    if (cut === 0) return ran
    return { result: { ...ran.result, stdout: clipped } }
  }).catch(($, e, next) => next(e))

  // While a job is open, a message that sounds like a final yes reminds Claude to deliver and clean up.
  on('prompt.submit', async ($, e, next) => {
    if (!jobLine || !APPROVAL.test(e.text) || NOT_YET.test(e.text)) return next(e)
    return next({ ...e, context: [...(e.context ?? []),
      `${jobLine}. If this message approves the final asset as definitive: deliver it with ${tokprep($.plugin.root)} job deliver <file> --to <folder> ` +
      `(if not done yet), then run ${tokprep($.plugin.root)} job done to delete every temporary file of the job, and tell the person how much space was freed. ` +
      `If they still want changes, keep working inside the job folder (${tokprep($.plugin.root)} job dir).`] })
  }).catch(($, e, next) => next(e))

  // After a turn that closed a job: the job's iterations are dead weight in the context, so compact once the turn is over.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!finished || e.agentId !== undefined) return result
    const job = finished
    finished = undefined
    void (async () => {
      for (const wait of [1500, 4000, 10000]) {           // compaction waits until the turn has fully ended
        await $.clock.sleep(wait)
        try {
          const { context } = await $.session.usage()
          const pct = Math.round(context.percent ?? 0)
          if (pct < COMPACT_AT) return
          await $.session.compact({ instructions:
            `The job "${job.name}" is finished: the person approved the final asset, it was delivered and its temporary files were deleted (${job.freed}). ` +
            `Keep: where the final files are, the person's preferences and decisions, and anything still open. Drop: the intermediate versions, frame sheets and tool output of this job.` })
          return
        } catch { /* the turn is still running: try again a little later */ }
      }
    })().catch(() => undefined)        // the module reloading mid-wait drops the compaction, quietly
    return result
  }).catch(($, e, next) => next(e))
}
