// tokspeech — on-device speech to text with Apple SpeechAnalyzer (macOS 26+), for `tokprep media`.
//
//   tokspeech <audio file> [locale]     plain transcript on stdout (locale defaults to the system language)
//
// Exit 3 = not available here (macOS older than 26, or the language is not supported); tokprep then
// leaves the transcript out. The language model is downloaded once by macOS and shared with the system.
//
// Build once: swiftc -O tokspeech.swift -o tokspeech   (needs the macOS 26 SDK)
import AVFoundation
import Foundation
import Speech

func fail(_ msg: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(code)
}

@available(macOS 26, *)
func transcribe(_ url: URL, _ wanted: Locale) async throws -> String {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
        fail("language \(wanted.identifier) not supported by SpeechTranscriber", 3)
    }
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await install.downloadAndInstall()
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let collect = Task { () -> [String] in
        var parts: [String] = []
        for try await r in transcriber.results where r.isFinal { parts.append(String(r.text.characters)) }
        return parts
    }
    let file = try AVAudioFile(forReading: url)
    if let end = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: end)
    } else {
        await analyzer.cancelAndFinishNow()
    }
    return try await collect.value.joined(separator: " ")
}

let args = Array(CommandLine.arguments.dropFirst())
guard let path = args.first else { fail("usage: tokspeech <audio file> [locale]") }
let wanted = args.count > 1 ? Locale(identifier: args[1]) : Locale.current

if #available(macOS 26, *) {
    do { print(try await transcribe(URL(fileURLWithPath: path), wanted)) }
    catch { fail("transcription failed: \(error.localizedDescription)") }
} else {
    fail("SpeechAnalyzer needs macOS 26", 3)
}
