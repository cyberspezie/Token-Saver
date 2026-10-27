# token-saver: a Claude Code plugin

**A plugin for [Claude Code](https://claude.com/claude-code) that saves tokens.** Your computer does the heavy reading locally and for free: text recognition, face detection, video scene sheets, file search and file outlines. Claude then reads a one-page summary and at most two images, instead of every screenshot, video frame or long file.

It works silently. There is no status line and no pop-ups: it only changes what Claude reads.

| Without it | With it |
| --- | --- |
| 6 page screenshots to check a layout: ~6,000 tokens | 1 summary (overflow, broken images, tiny text) + 1 sheet: ~1,700 tokens |
| 12 frames of a 3-minute video: ~15,000 tokens | 1 sheet with one frame per scene + cut list: ~1,700 tokens |
| A 5,500-line HTML file read whole: ~99,000 tokens | A one-page outline: ~1,000 tokens |
| `grep` hitting a minified CSS line: ~6,000 tokens | The same line clipped: ~70 tokens |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install token-saver --marketplace cyberspezie/token-saver
```

Answer `y` to add the marketplace, then pick the **user** scope so it works in every project.

From a shell:

```
claude plugin install token-saver --marketplace cyberspezie/token-saver
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `cyberspezie/token-saver`, then **Add plugin**.

## What it does inside Claude Code

- **Before Claude reads a heavy file**, it suggests the local prep step once: an image (a screenshot gets OCR), a video (it gets a scene sheet), or a text file over 60 KB read whole (it gets an outline). If Claude reads the same file again, the read goes through.
- **Long lines in shell output** (minified CSS, JSON) are clipped to 240 characters. Put `TOKPREP_RAW=1` in a command to get its full output.
- **A `find` over the whole home folder** is pointed to the system's search index (Spotlight, Windows Search) instead.
- **Media jobs:** when Claude makes an asset for you (a video edit, a cutout, a gif), its temporary files go in one job folder. Once you approve the final version, they are deleted and the conversation is compacted, which frees both disk space and context.
- **A skill** tells Claude which command fits which task.

## The `tokprep` commands

Claude runs these itself; you don't need to.

| Command | What it does locally | What Claude reads |
| --- | --- | --- |
| `tokprep ocr <images>` | text recognition | the text |
| `tokprep faces <images>` | face boxes and capture quality | one line per image + a sheet of face crops |
| `tokprep media <images/videos/folder>` | size, text, faces, people, scene changes, Whisper transcript | summary + 1–2 contact sheets |
| `tokprep scenes <video>` | one frame per scene change (flashes merged), cut list, shot lengths | summary + 1 sheet |
| `tokprep cutout <image/video> --bg transparent\|green\|#hex\|bg.jpg` | removes the background / makes a green screen | coverage % + a before/after sheet |
| `tokprep key <image/video>` | removes an existing green/blue screen (ffmpeg chromakey) | one line + a sheet |
| `tokprep find <words> [--kind image\|video\|pdf…] [--days N]` | searches with the system search index | a short list grouped by folder |
| `tokprep asset <op> <files>` | ffmpeg edits: resize, convert, crop, web export, trim, gif, poster frame, audio, mute, speed, rotate, colour grade | one line per file: before → after |
| `tokprep web <url or file.html>` | headless Edge/Chrome at desktop and phone widths: overflow, broken or oversized images, tiny text, console errors | summary + sliced screenshots on a sheet |
| `tokprep file <path>` / `peek` / `grep` | outline of a long file (code, HTML, Markdown, Word, PDF, epub, subtitles); views with long lines clipped | one page / the clipped lines |
| `tokprep job start\|deliver\|done` | temporary files of an asset; deleted after you approve the final | status lines |

## macOS, Windows, and machines without the tools

Each command uses the Apple tool on macOS, the Windows alternative when the machine has one, and otherwise answers `NOT AVAILABLE on this machine`. Claude then does the job directly, as it would without the plugin.

| Job | macOS | Windows | Otherwise |
| --- | --- | --- | --- |
| Text in images | Apple Vision | Windows OCR (built in) | Claude reads the image |
| Faces | Apple Vision | Windows FaceDetector (built in) | not available |
| Cutout / green screen | Apple Vision | `rembg`, if installed | not available (`key` works everywhere) |
| File search | Spotlight | Everything (`es.exe`) if installed, else Windows Search | Claude's own search |
| Contact sheets, scenes, edits | CoreGraphics + ffmpeg | ffmpeg | ffmpeg |
| Word / PDF text | `textutil` / PDFKit | `.docx`/`.odt` directly; `pdftotext` if installed | Claude reads the PDF |
| Transcripts | Whisper CLI, if installed | Whisper CLI, if installed | none |

The Windows path is written against the Windows APIs and has not yet been run on a Windows machine. Issues are welcome.

## Requirements

- Claude Code with plugin support.
- `ffmpeg` and Python 3.
- Node.js 22+ and Edge or Chrome, for page checks.
- macOS: the Xcode command-line tools (`swiftc`); the Vision helper compiles itself on first use into `~/.cache/tokprep/`.
- Optional: `ctags`, a Whisper CLI (`whisper-cpp`), `rembg`, `pdftotext`, Everything.

## Privacy and safety

- **Everything runs on your machine.** The plugin sends nothing anywhere. The page check talks only to the local headless browser on `127.0.0.1`.
- **Your files are never overwritten.** Outputs get `-1`, `-2` added to their names.
- **Job cleanup only deletes what the job made:** its own work folder, plus files you registered that are newer than the job. It refuses to run before a final is delivered, and never touches a delivered final, your home folder, its top-level folders or the destination folder.
- Prep outputs live in `~/.cache/tokprep/`; `tokprep clean --days 7` removes old ones.

## Uninstall

```
claude plugin uninstall token-saver@cyberspezie
```
