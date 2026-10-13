import AppKit
import Foundation

// Original vector artwork, rendered locally with AppKit. No downloaded assets.
let destination = URL(fileURLWithPath: CommandLine.arguments[1])
var chunks = Data()
func bigEndian(_ value: UInt32) -> Data {
    var number = value.bigEndian
    return withUnsafeBytes(of: &number) { Data($0) }
}
for (size, kind) in [(16, "icp4"), (32, "icp5"), (64, "icp6"), (128, "ic07"), (256, "ic08"), (512, "ic09"), (1024, "ic10")] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let transform = AffineTransform(scale: Double(size) / 1024)
    (transform as NSAffineTransform).concat()
    let tile = NSBezierPath(roundedRect: NSRect(x: 80, y: 80, width: 864, height: 864), xRadius: 205, yRadius: 205)
    NSGradient(starting: NSColor(calibratedRed: 0.02, green: 0.25, blue: 0.70, alpha: 1),
               ending: NSColor(calibratedRed: 0.08, green: 0.70, blue: 0.86, alpha: 1))!.draw(in: tile, angle: 70)
    NSColor.white.withAlphaComponent(0.15).setStroke(); tile.lineWidth = 4; tile.stroke()
    let halo = NSBezierPath(ovalIn: NSRect(x: 178, y: 178, width: 668, height: 668))
    NSColor.white.withAlphaComponent(0.08).setFill(); halo.fill()
    let band = NSBezierPath()
    band.move(to: NSPoint(x: 270, y: 370))
    band.curve(to: NSPoint(x: 754, y: 370), controlPoint1: NSPoint(x: 218, y: 880), controlPoint2: NSPoint(x: 806, y: 880))
    band.lineWidth = 52; band.lineCapStyle = .round
    NSColor.white.setStroke(); band.stroke()
    for x in [CGFloat(238), CGFloat(662)] {
        let cup = NSBezierPath(roundedRect: NSRect(x: x, y: 296, width: 124, height: 248), xRadius: 56, yRadius: 56)
        NSColor.white.setFill(); cup.fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    let png = bitmap.representation(using: .png, properties: [:])!
    chunks.append(Data(kind.utf8)); chunks.append(bigEndian(UInt32(png.count + 8))); chunks.append(png)
}
var icon = Data("icns".utf8)
icon.append(bigEndian(UInt32(chunks.count + 8))); icon.append(chunks)
try icon.write(to: destination, options: .withoutOverwriting)
