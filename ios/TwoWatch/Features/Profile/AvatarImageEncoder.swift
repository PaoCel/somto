import UIKit

/// Encoder unico degli avatar: qualunque punto dell'app carichi una foto
/// profilo deve produrre lo stesso formato (quadrato 800x800, JPEG 0.86,
/// opaco). Prima i parametri vivevano solo dentro l'editor di ritaglio di
/// `EditProfileView`; con l'onboarding che carica un avatar senza passare da
/// lì servono in un posto solo, o i due percorsi divergono.
enum AvatarImageEncoder {
    static let outputSide: CGFloat = 800
    static let compressionQuality: CGFloat = 0.86

    /// Riscrive un `CGImage` già ritagliato nel formato avatar.
    static func encode(_ image: CGImage) -> Data? {
        let outputSize = CGSize(width: outputSide, height: outputSide)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: outputSize, format: format)
        let rendered = renderer.image { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: outputSize))
            UIImage(cgImage: image).draw(in: CGRect(origin: .zero, size: outputSize))
        }
        return rendered.jpegData(compressionQuality: compressionQuality)
    }

    /// Ritaglia al centro il quadrato più grande possibile e codifica.
    /// Usato dove non c'è (e non deve esserci) un editor di ritaglio: in
    /// onboarding l'avatar è una richiesta leggera, non un passaggio in più.
    static func centerSquareJPEG(from data: Data) -> Data? {
        guard let image = UIImage(data: data)?.normalizedUp(),
              let cgImage = image.cgImage else { return nil }

        let side = min(cgImage.width, cgImage.height)
        let cropRect = CGRect(
            x: (cgImage.width - side) / 2,
            y: (cgImage.height - side) / 2,
            width: side,
            height: side
        )
        guard let cropped = cgImage.cropping(to: cropRect) else { return nil }
        return encode(cropped)
    }
}

private extension UIImage {
    /// Ridisegna l'immagine con orientamento `.up`: senza questo passaggio il
    /// `cgImage` sottostante ignora l'EXIF e le foto scattate in verticale
    /// vengono ritagliate ruotate.
    func normalizedUp() -> UIImage {
        guard imageOrientation != .up else { return self }
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in
            draw(in: CGRect(origin: .zero, size: size))
        }
    }
}
