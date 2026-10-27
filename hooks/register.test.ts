import { expect, mock, test } from 'claude-code/testing'

test('an image Read is steered to tokprep once, then goes through', async ($, on) => {
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { type: 'image' } }))

  const first = await $.tool.call({ tool: 'Read', file_path: '/x/shot.png' })
  expect(String(first.deny)).toMatch(/tokprep" media/)

  const shot = await $.tool.call({ tool: 'Read', file_path: '/x/Schermata 2026-10-26.png' })
  expect(String(shot.deny)).toMatch(/tokprep" ocr/)

  const video = await $.tool.call({ tool: 'Read', file_path: '/x/clip.mov' })
  expect(String(video.deny)).toMatch(/tokprep" scenes/)

  const again = await $.tool.call({ tool: 'Read', file_path: '/x/shot.png' })
  expect(again.deny).toBeUndefined()
})

test('a big text file Read without a range gets the outline hint; a ranged Read passes', async ($, on) => {
  on('fs.stat', () => ({ value: { kind: 'file', size: 357_000, mtimeMs: 0, isLink: false } }))
  on('tool.call', () => ({ result: { type: 'text' } }))

  const whole = await $.tool.call({ tool: 'Read', file_path: '/p/index.html' })
  expect(String(whole.deny)).toMatch(/tokprep" file/)

  const ranged = await $.tool.call({ tool: 'Read', file_path: '/p/other.html', offset: 100, limit: 50 })
  expect(ranged.deny).toBeUndefined()
})

test('minified lines in shell output are clipped unless TOKPREP_RAW=1', async ($, on) => {
  const css = '<style id="tailwind">' + 'a{b:c}'.repeat(4000)
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { stdout: `1558: ok\n1559: ${css}\n1560: </head>`, stderr: '' } }))

  const ran = await $.tool.call({ tool: 'Bash', command: 'sed -n 1558,1560p index.html' })
  const out = (ran.result as { stdout: string }).stdout
  expect(out).toMatch(/1558: ok/)
  expect(out).toMatch(/chars clipped/)
  expect(out.length).toBeLessThan(600)

  const raw = await $.tool.call({ tool: 'Bash', command: 'TOKPREP_RAW=1 sed -n 1559p index.html' })
  expect((raw.result as { stdout: string }).stdout.length).toBeGreaterThan(20_000)
})

test('a find over the whole home folder is steered to Spotlight once', async ($, on) => {
  on('tool.call', () => ({ result: { stdout: '/Users/x/a.png', stderr: '' } }))

  const first = await $.tool.call({ tool: 'Bash', command: 'find ~ -name "*.png"' })
  expect(String(first.deny)).toMatch(/tokprep" find/)

  const again = await $.tool.call({ tool: 'Bash', command: 'find ~ -name "*.png"' })
  expect(again.deny).toBeUndefined()

  const local = await $.tool.call({ tool: 'Bash', command: 'find ./src -name "*.ts"' })
  expect(local.deny).toBeUndefined()
})

test('with a job open, a final yes reminds Claude to deliver and clean up; a "not yet" does not', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'job reel · 120.0 MB temporary · 0 final(s)\n', stderr: '' } }))
  on('ui.status', () => ({ value: undefined }))
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => { seen.push(e.context); return { text: e.text } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'perfetto, approvato!', wait: true, origin: undefined as never })
  await $.prompt.submit({ text: 'non ancora, cambia il colore', wait: true, origin: undefined as never })

  expect(String(seen[0]?.join(' '))).toMatch(/job done/)
  expect(seen[1]?.some(c => c.includes('token-saver'))).toBeFalsy()
})

test('a closed job compacts the conversation at the end of the turn when the context is full enough', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'no job open\n', stderr: '' } }))
  on('ui.status', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: string }).text ?? e)); return { value: undefined } })
  on('tool.call', () => ({ result: { stdout: 'deleted 3 temporary path(s), 1.2 GB\nTOKPREP_JOB_DONE name="reel" freed=1288490188', stderr: '' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, percent: 62 }, rateLimits: {}, cost: {} } }))
  const compactions: (string | undefined)[] = []
  on('session.compact', (_, e) => { compactions.push(e.instructions); return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } })
  on('turn.complete', () => ({ text: '' }))

  await $.tool.call({ tool: 'Bash', command: 'tokprep job done' })
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await clock.advance(2000)
  await clock.settle()

  expect(compactions.length).toBe(1)
  expect(String(compactions[0])).toMatch(/reel/)
})

test('the system prompt carries the tokprep command for this machine and the do-it-directly fallback', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'core', scope: 'shared' }] }))
  const r = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: ['Read'], outputStyle: null, traits: [], sections: [] } as never)
  const mine = r.sections.find(s => s.id === 'token-saver:command')
  expect(mine?.text).toMatch(/bin\/tokprep/)
  expect(mine?.text).toMatch(/NOT AVAILABLE/)
  expect(mine?.scope).toBe('session')
})
