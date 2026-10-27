// tokvision — Apple Vision + CoreGraphics helpers for tokprep (no dependencies).
//
//   tokvision info   <image>...                               JSON: size, OCR text, faces, people
//   tokvision ocr    [--fast] <image>...                      recognised text, one block per image
//   tokvision faces  [--crops <dir>] <image>...               JSON: face boxes (pixels, top-left origin), quality
//   tokvision cutout <auto|subject|person> <bg> <outdir> <in>...  cut out the subject; bg = transparent | green | blue | #RRGGBB | <image>
//   tokvision sheet  <out.jpg> <cols> <label|path>...         one labelled contact sheet, long edge <= 1568px
//
// Build once: swiftc -O tokvision.swift -o tokvision
import AppKit
import CoreImage
import Foundation
import Vision

func load(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func fail(_ msg: String) -> Never { FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(1) }

func printJSON(_ v: Any) {
    print(String(data: try! JSONSerialization.data(withJSONObject: v, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
}

// Text in reading order: observations grouped into lines (similar midY), lines top to bottom.
func recognise(_ img: CGImage, fast: Bool = false) -> [String] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = fast ? .fast : .accurate
    req.recognitionLanguages = ["it-IT", "en-US"]
    req.usesLanguageCorrection = !fast
    try? VNImageRequestHandler(cgImage: img).perform([req])
    var lines: [(y: CGFloat, parts: [(x: CGFloat, s: String)])] = []
    for o in req.results ?? [] {
        guard let s = o.topCandidates(1).first?.string else { continue }
        let b = o.boundingBox
        if let i = lines.firstIndex(where: { abs($0.y - b.midY) < b.height * 0.5 }) { lines[i].parts.append((b.minX, s)) }
        else { lines.append((b.midY, [(b.minX, s)])) }
    }
    return lines.sorted { $0.y > $1.y }.map { $0.parts.sorted { $0.x < $1.x }.map(\.s).joined(separator: "  ") }
}

func info(_ path: String) -> [String: Any] {
    guard let img = load(path) else { return ["path": path, "error": "unreadable"] }
    let faces = VNDetectFaceRectanglesRequest()
    let people = VNDetectHumanRectanglesRequest()
    try? VNImageRequestHandler(cgImage: img).perform([faces, people])
    return ["path": path, "width": img.width, "height": img.height,
            "text": recognise(img).joined(separator: " / "),
            "faces": faces.results?.count ?? 0, "people": people.results?.count ?? 0]
}

func faces(_ path: String, crops: String?) -> [String: Any] {
    guard let img = load(path) else { return ["path": path, "error": "unreadable"] }
    let rects = VNDetectFaceRectanglesRequest()
    let quality = VNDetectFaceCaptureQualityRequest()
    let handler = VNImageRequestHandler(cgImage: img)
    try? handler.perform([rects])
    quality.inputFaceObservations = rects.results ?? []
    try? handler.perform([quality])
    let W = CGFloat(img.width), H = CGFloat(img.height)
    let found = (quality.results ?? rects.results ?? []).enumerated().map { (i, f) -> [String: Any] in
        let b = f.boundingBox   // normalised, origin bottom-left
        let box = CGRect(x: b.minX * W, y: (1 - b.maxY) * H, width: b.width * W, height: b.height * H).integral
        var out: [String: Any] = ["x": Int(box.minX), "y": Int(box.minY), "w": Int(box.width), "h": Int(box.height)]
        if let q = f.faceCaptureQuality { out["quality"] = (Double(q) * 100).rounded() / 100 }
        if let dir = crops {
            let pad = box.insetBy(dx: -box.width * 0.3, dy: -box.height * 0.3).intersection(CGRect(x: 0, y: 0, width: W, height: H))
            if let c = img.cropping(to: pad) {
                let file = "\(dir)/\(((path as NSString).lastPathComponent as NSString).deletingPathExtension)-face\(i + 1).jpg"
                writeImage(c, to: file, type: "public.jpeg"); out["crop"] = file
            }
        }
        return out
    }.sorted { ($0["x"] as! Int) < ($1["x"] as! Int) }
    return ["path": path, "width": img.width, "height": img.height, "faces": found]
}

func writeImage(_ cg: CGImage, to path: String, type: String) {
    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, type as CFString, 1, nil) else { fail("cannot write \(path)") }
    CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.88] as CFDictionary)
    CGImageDestinationFinalize(dest)
}

// Share of the frame a mask keeps (0...1), from its average brightness.
func coverage(_ m: CIImage, _ ctx: CIContext) -> Double {
    let avg = m.applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: CIVector(cgRect: m.extent)])
    var px = [UInt8](repeating: 0, count: 4)
    ctx.render(avg, toBitmap: &px, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8, colorSpace: nil)
    return Double(px[0]) / 255
}

// Mask at full image resolution: "subject" = any foreground subject (macOS 14+), "person" = people only,
// "auto" = subject, then person when no subject is found.
func mask(_ img: CGImage, mode: String) -> CIImage? {
    if mode == "auto" { return mask(img, mode: "subject") ?? mask(img, mode: "person") }
    let handler = VNImageRequestHandler(cgImage: img)
    if mode == "person" {
        let req = VNGeneratePersonSegmentationRequest()
        req.qualityLevel = .accurate
        req.outputPixelFormat = kCVPixelFormatType_OneComponent8
        try? handler.perform([req])
        guard let buf = req.results?.first?.pixelBuffer else { return nil }
        let m = CIImage(cvPixelBuffer: buf)
        let scaled = m.transformed(by: CGAffineTransform(scaleX: CGFloat(img.width) / m.extent.width, y: CGFloat(img.height) / m.extent.height))
        return coverage(scaled, CIContext()) > 0.002 ? scaled : nil
    }
    let req = VNGenerateForegroundInstanceMaskRequest()
    try? handler.perform([req])
    guard let obs = req.results?.first,
          let buf = try? obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler) else { return nil }
    return CIImage(cvPixelBuffer: buf)
}

func background(_ spec: String, extent: CGRect) -> CIImage {
    func hex(_ s: String) -> CIColor {
        let v = UInt32(s.dropFirst(), radix: 16) ?? 0x00FF00
        return CIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255)
    }
    switch spec {
    case "transparent": return CIImage(color: .clear).cropped(to: extent)
    case "green": return CIImage(color: hex("#00B140")).cropped(to: extent)    // broadcast chroma green
    case "blue": return CIImage(color: hex("#0047BB")).cropped(to: extent)
    case let s where s.hasPrefix("#"): return CIImage(color: hex(s)).cropped(to: extent)
    default:   // an image: scale to cover, centre-crop
        guard let bg = load(spec) else { fail("cannot read background \(spec)") }
        let ci = CIImage(cgImage: bg)
        let s = max(extent.width / ci.extent.width, extent.height / ci.extent.height)
        let scaled = ci.transformed(by: CGAffineTransform(scaleX: s, y: s))
        return scaled.transformed(by: CGAffineTransform(translationX: (extent.width - scaled.extent.width) / 2, y: (extent.height - scaled.extent.height) / 2)).cropped(to: extent)
    }
}

func cutout(mode: String, bg: String, outdir: String, inputs: [String]) {
    let ctx = CIContext()
    var bgCache: (CGSize, CIImage)?
    var done = 0, missed: [String] = [], kept: [Double] = []
    for path in inputs {
        guard let img = load(path) else { missed.append(path); continue }
        let fg = CIImage(cgImage: img)
        guard let m = mask(img, mode: mode) else { missed.append(path); continue }
        kept.append(coverage(m, ctx))
        if bgCache == nil || bgCache!.0 != fg.extent.size { bgCache = (fg.extent.size, background(bg, extent: fg.extent)) }
        let blend = CIFilter(name: "CIBlendWithMask", parameters: [kCIInputImageKey: fg, kCIInputBackgroundImageKey: bgCache!.1, kCIInputMaskImageKey: m])!.outputImage!
        let name = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        let out = URL(fileURLWithPath: "\(outdir)/\(name).png")
        try? ctx.writePNGRepresentation(of: blend.cropped(to: fg.extent), to: out, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        done += 1
    }
    let k = kept.sorted(), pct = { (v: Double) in String(format: "%.1f%%", v * 100) }
    print("cut out \(done)/\(inputs.count)" + (k.isEmpty ? "" : " · subject covers \(pct(k.first!))–\(pct(k.last!)) of the frame (median \(pct(k[k.count / 2])))") + (missed.isEmpty ? "" : "; no subject found in: " + missed.map { ($0 as NSString).lastPathComponent }.prefix(10).joined(separator: ", ")))
}

func sheet(out: String, cols: Int, items: [(String, String)]) {
    let imgs = items.compactMap { item in load(item.1).map { (item.0, $0) } }
    guard !imgs.isEmpty else { fail("no images") }
    let cols = max(1, min(cols, imgs.count)), rows = (imgs.count + cols - 1) / cols
    // cell aspect = median aspect of inputs, clamped so very tall pages do not crush the grid
    let aspects = imgs.map { Double($0.1.height) / Double($0.1.width) }.sorted()
    let aspect = min(max(aspects[aspects.count / 2], 0.4), 2.2)
    let label = 22.0, gap = 6.0
    // never upscale: a cell is at most as wide as the widest input
    var cellW = min(1568.0 / Double(cols) - gap, Double(imgs.map { $0.1.width }.max()!))
    var cellH = cellW * aspect
    let totalH = Double(rows) * (cellH + label + gap)
    if totalH > 1568 { let k = 1568 / totalH; cellW *= k; cellH *= k }
    let W = Int(Double(cols) * (cellW + gap)), H = Int(Double(rows) * (cellH + label + gap))
    let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(gray: 0.12, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 13, weight: .medium),
                                                .foregroundColor: NSColor.white]
    for (i, (name, img)) in imgs.enumerated() {
        let c = Double(i % cols), r = Double(i / cols)
        let x = c * (cellW + gap), top = Double(H) - r * (cellH + label + gap)
        // fit image inside the cell, keep aspect, align top
        let s = min(cellW / Double(img.width), cellH / Double(img.height))
        let w = Double(img.width) * s, h = Double(img.height) * s
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: x + (cellW - w) / 2, y: top - label - h, width: w, height: h))
        NSAttributedString(string: name, attributes: attrs).draw(at: NSPoint(x: x + 4, y: top - label + 4))
    }
    writeImage(ctx.makeImage()!, to: out, type: "public.jpeg")
    print("\(out) \(W)x\(H) ~\(W * H / 750) tokens")
}

var args = Array(CommandLine.arguments.dropFirst())
let cmd = args.isEmpty ? "" : args.removeFirst()
func flag(_ name: String) -> Bool { if let i = args.firstIndex(of: name) { args.remove(at: i); return true }; return false }
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let v = args[i + 1]; args.removeSubrange(i...i + 1); return v
}

switch cmd {
case "info":
    printJSON(args.map(info))
case "ocr":
    let fast = flag("--fast")
    for p in args {
        guard let img = load(p) else { print("## \(p)\n(unreadable)\n"); continue }
        let lines = recognise(img, fast: fast)
        print("## \((p as NSString).lastPathComponent) (\(img.width)×\(img.height))\n" + (lines.isEmpty ? "(no text)" : lines.joined(separator: "\n")) + "\n")
    }
case "faces":
    let crops = option("--crops")
    printJSON(args.map { faces($0, crops: crops) })
case "cutout" where args.count >= 4:
    cutout(mode: args[0], bg: args[1], outdir: args[2], inputs: Array(args.dropFirst(3)))
case "sheet" where args.count >= 3:
    let items = args.dropFirst(2).map { a -> (String, String) in
        let p = a.split(separator: "|", maxSplits: 1).map(String.init)
        return p.count == 2 ? (p[0], p[1]) : ((a as NSString).lastPathComponent, a)
    }
    sheet(out: args[0], cols: Int(args[1]) ?? 3, items: items)
default:
    print("usage: tokvision info|ocr|faces|cutout|sheet …  (see the header of tokvision.swift)")
    exit(2)
}
