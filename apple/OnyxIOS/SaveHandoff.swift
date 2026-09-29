import ImageIO
import OnyxKit
import Photos
import UIKit

/// Into the photo library. Add-only: Onyx asks to put pictures in, never to
/// read what is there.
enum PhotosSaver {
    enum Outcome: Equatable {
        case saved
        /// Photos will not take it, and why. The file is still here, for Files.
        case unsupported(String)
        /// Onyx may not add to the library (Settings › Privacy › Photos).
        case denied
        case failed(String)
    }

    /// Whether Onyx may add to the library, asking the first time.
    static func authorize() async -> Bool {
        switch PHPhotoLibrary.authorizationStatus(for: .addOnly) {
        case .authorized, .limited:
            return true
        case .notDetermined:
            let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
            return status == .authorized || status == .limited
        default:
            return false
        }
    }

    /// Adds the file as a picture or a video, under its own name. `moving`
    /// hands the file itself to the library, so a 4 GB video is not
    /// briefly two. Checked before it is offered to Photos: a name can say
    /// .mov of something no player can open.
    static func save(_ url: URL, name: String, as support: PhotosSupport, moving: Bool) async -> Outcome {
        let type: PHAssetResourceType
        switch support {
        case .photo:
            guard isPicture(url) else { return .unsupported("Photos can't open this picture.") }
            type = .photo
        case .video:
            guard UIVideoAtPathIsCompatibleWithSavedPhotosAlbum(url.path) else {
                return .unsupported("Photos can't play this video.")
            }
            type = .video
        case let .unsupported(reason):
            return .unsupported(reason)
        }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = name
                options.shouldMoveFile = moving
                PHAssetCreationRequest.forAsset().addResource(with: type, fileURL: url, options: options)
            }
            return .saved
        } catch {
            return classify(error)
        }
    }

    static func classify(_ error: Error) -> Outcome {
        let ns = error as NSError
        if ns.domain == PHPhotosErrorDomain {
            switch ns.code {
            case PHPhotosError.Code.invalidResource.rawValue:
                return .unsupported("Photos can't import this file.")
            case PHPhotosError.Code.accessUserDenied.rawValue, PHPhotosError.Code.accessRestricted.rawValue:
                return .denied
            case PHPhotosError.Code.notEnoughSpace.rawValue:
                return .failed("There isn't room in Photos for this.")
            default:
                break
            }
        }
        return .failed(ns.localizedDescription)
    }

    private static func isPicture(_ url: URL) -> Bool {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
        else { return false }
        return CGImageSourceGetCount(source) > 0 && CGImageSourceGetType(source) != nil
    }
}

/// Hands files to the Files app's folder picker or to the share sheet, from
/// whatever is on screen when they are ready — the folder, or a file open
/// full screen over it.
@MainActor
enum Handoff {
    /// The picker's delegate, held until it answers: the picker holds it weakly.
    private static var exporting: ExportDelegate?

    /// The screen everything else is presented over.
    static var top: UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = (scenes.first { $0.activationState == .foregroundActive } ?? scenes.first)?.windows ?? []
        var top = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController
        while let next = top?.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }

    /// Whether something could be shown now: the app on screen, and nothing
    /// mid-way through appearing or going.
    static var canPresent: Bool {
        guard UIApplication.shared.applicationState == .active, let top else { return false }
        return !top.isBeingPresented && !top.isBeingDismissed
    }

    /// The Files app's picker, moving the files to the folder chosen — they
    /// are already this app's own copies, so nothing is copied twice.
    /// `done` hears whether they were saved.
    static func exportToFiles(_ urls: [URL], done: @escaping (Bool) -> Void) -> Bool {
        guard canPresent, let top else { return false }
        let picker = UIDocumentPickerViewController(forExporting: urls, asCopy: false)
        let delegate = ExportDelegate { saved in
            exporting = nil
            done(saved)
        }
        exporting = delegate
        picker.delegate = delegate
        picker.shouldShowFileExtensions = true
        top.present(picker, animated: true)
        return true
    }

    /// The share sheet. `done` hears when it has closed, and whether
    /// something was done with the files.
    static func share(_ urls: [URL], done: @escaping (Bool) -> Void) -> Bool {
        guard canPresent, let top else { return false }
        let sheet = UIActivityViewController(activityItems: urls, applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, completed, _, _ in done(completed) }
        if let popover = sheet.popoverPresentationController {
            // An iPad shows it as a popover, which needs somewhere to point.
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY - 88, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        top.present(sheet, animated: true)
        return true
    }

    struct Action {
        let title: String
        var style: UIAlertAction.Style = .default
        let run: () -> Void
    }

    static func alert(_ title: String, message: String, actions: [Action]) {
        guard let top else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        for action in actions {
            alert.addAction(UIAlertAction(title: action.title, style: action.style) { _ in action.run() })
        }
        top.present(alert, animated: true)
    }

    static func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

private final class ExportDelegate: NSObject, UIDocumentPickerDelegate {
    private let answer: (Bool) -> Void
    private var answered = false

    init(_ answer: @escaping (Bool) -> Void) { self.answer = answer }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finish(true) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(false) }

    private func finish(_ saved: Bool) {
        guard !answered else { return }
        answered = true
        answer(saved)
    }
}
