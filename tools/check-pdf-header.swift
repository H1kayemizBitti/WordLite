// CI 用：检查 Mac 显式纸张导出的 PDF 每页是否真的带页眉、页脚、页码
// 用法：swift tools/check-pdf-header.swift <pdf>
import Foundation
import PDFKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func squash(_ text: String) -> String {
    text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("用法：swift tools/check-pdf-header.swift <pdf>")
}
let path = arguments[1]
guard FileManager.default.fileExists(atPath: path) else {
    fail("找不到 PDF：\(path)")
}
guard let document = PDFDocument(url: URL(fileURLWithPath: path)) else {
    fail("PDF 打不开：\(path)")
}
guard document.pageCount >= 2 else {
    fail("PDF 只有 \(document.pageCount) 页，至少应有 2 页")
}

var problems: [String] = []
for index in 0..<document.pageCount {
    let text = squash(document.page(at: index)?.string ?? "")
    let page = index + 1
    if !(text.contains("简写") && text.contains("WordLite")) {
        problems.append("第 \(page) 页缺少页眉")
    }
    if !text.contains("内部资料") {
        problems.append("第 \(page) 页缺少页脚")
    }
    // PDF 提取可能在“—”和数字之间插空格/换行；去掉空白再比对
    let compact = text.replacingOccurrences(of: " ", with: "")
    if !compact.contains("—\(page)—") {
        problems.append("第 \(page) 页缺少页码（期望 — \(page) —）")
    }
}

// 显式纸张自测样张是 120 段带编号的正文；逐段核对，防止页底内容被裁掉。
// 样张段数改了的话，这里也要同步。
let allText = (0..<document.pageCount)
    .map { squash(document.page(at: $0)?.string ?? "") }
    .joined(separator: " ")
let pattern = "第\\s*(\\d+)\\s*段"
let regex = try! NSRegularExpression(pattern: pattern)
let nsText = allText as NSString
var counts: [Int: Int] = [:]
regex.enumerateMatches(in: allText, range: NSRange(location: 0, length: nsText.length)) { match, _, _ in
    guard let match = match, let range = Range(match.range(at: 1), in: allText),
          let number = Int(allText[range]) else { return }
    counts[number, default: 0] += 1
}
for number in 1...120 {
    if let count = counts[number], count > 1 {
        problems.append("第 \(number) 段出现 \(count) 次")
    } else if counts[number] == nil {
        problems.append("PDF 缺少第 \(number) 段")
    }
}

if problems.isEmpty {
    print("PDF 页眉页脚页码检查通过（\(document.pageCount) 页，120 段正文完整）")
} else {
    problems.forEach { FileHandle.standardError.write(($0 + "\n").data(using: .utf8)!) }
    exit(1)
}
