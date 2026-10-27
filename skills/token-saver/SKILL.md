---
name: token-saver
description: Local Mac tools that do the heavy reading before Claude does - text in images (OCR), face detection, green screen / background removal and chroma key, Spotlight file search, one-frame-per-scene video contact sheets, Whisper transcripts, and ffmpeg edits of photos, videos, gifs and audio (resize, convert, crop, web export, trim, gif, poster frame, speed, rotate, colour grade). Use whenever a task involves looking at images, screenshots or video, finding files on this Mac, cutting out a subject or replacing a background, or editing media assets.
---

# token-saver: `tokprep`

The exact command for this machine is in your system prompt ("Local media/file prep on this machine: …"). On macOS that is the `tokprep` script, also linked at `~/.local/bin/tokprep`; on Windows it is `python "<plugin>\bin\tokprep"`.

Each command uses the Apple tool on macOS (Vision, Spotlight, sips, PDFKit). Elsewhere it uses the Windows alternative when the machine has one: Windows OCR and face detection (built in), Windows Search or Everything (`es.exe`), `rembg` for cutouts, `pdftotext`, and ffmpeg for sheets. **If a command answers `NOT AVAILABLE on this machine`, do the task directly, as you would without tokprep:** read the image or PDF yourself, use your own search. The hooks let a second Read of the same file through. Each command does the work on the Mac and prints a short result, or writes `summary.md` plus at most two labelled sheets. Read the summary first. Open a sheet only when the summary can't answer the question, and open a raw file only when the sheet can't either.

| Need | Command |
| --- | --- |
| Words in a screenshot, photo or scan | `tokprep ocr <img|folder> [--fast]` |
| Faces: how many, where, how sharp | `tokprep faces <img|folder>`: boxes in pixels, quality 0–1, one sheet of crops |
| Overview of photos or videos | `tokprep media <files|folder>`: size, text, faces, people, scenes, Whisper transcript |
| What happens in a video | `tokprep scenes <video> [--threshold 0.3] [--max 24] [--min 1.0]`: cut list, shot lengths, one frame per scene |
| Cut a subject out / green screen | `tokprep cutout <img|video|folder> --bg transparent|green|blue|#hex|bg.jpg [--mode auto|subject|person] -o <dir>` |
| Remove an existing green/blue screen | `tokprep key <img|video> [--color auto] [--similarity 0.12] [--bg transparent|bg.jpg] -o <dir>` |
| Find files on this Mac | `tokprep find <words> [--kind image|video|pdf|doc|slides|sheet|code|audio|folder|3d] [--days N] [--name] [--in dir]` |
| Edit photos, videos, gifs, audio | `tokprep asset <op> <files|folder> [options] -o <dir> [--preview]`; run `tokprep asset` alone to list ops |
| Check a web page's layout | `tokprep web <url|file.html#anchor> [--widths 1440,390] [--select CSS]` |
| A long file | `tokprep file <path>`, then `tokprep peek <file> <a> <b>` / `tokprep grep <re> <file>` |

## Making an asset: always inside a job

When you edit a video or make any asset for the person (a cutout, a key, a gif, an edit, a render), keep the intermediates inside a job. That way they disappear once the final is approved.

1. `tokprep job start "<what you are making>" --dest "<folder the person wants the final in>"`
2. Put every intermediate in `$(tokprep job dir)`: tokprep's own outputs land there by themselves, and pass `-o "$(tokprep job dir)"` to your own ffmpeg/sips/python commands. Anything temporary you had to write elsewhere, register with `tokprep job track <path>`.
3. Show the person the candidate and ask whether it is the final version.
4. When they approve it as final: `tokprep job deliver <file> [--to <folder>] [--name <final name>]`, then `tokprep job done`. Tell them where the final is and how much space was freed. The mod compacts the conversation after that turn, so the job's iterations stop taking up context.
5. If they want changes, keep iterating in the same job. If they drop the asset entirely, use `tokprep job abandon`.

`tokprep job done` refuses to run before a final is delivered, never deletes a delivered final, and only deletes things the job made: its work folder, plus tracked files newer than the job and outside top-level or destination folders. Use `--dry-run` to see the list first. `tokprep clean --days 7` removes old prep summaries and sheets made outside jobs.

Rules:
- **Outputs:** final assets go wherever the person says (`job deliver --to`); never put intermediates in their folders. tokprep never overwrites a file; it adds `-1`, `-2` to the name.
- **Cutouts:** check the coverage numbers. 0% means no subject was found; above 80% means the background was kept. Look at the before/after sheet only if those look wrong. `--mode person` is for people only; `subject` also catches objects and dark silhouettes.
- **Chroma key:** a green halo means raise `--similarity` (0.15–0.2); holes in the subject mean lower it (0.08).
- **Formats:** transparent video comes out as ProRes 4444 `.mov`. WebP is not available in this ffmpeg build: use AVIF or JPG.
