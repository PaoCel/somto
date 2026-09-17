import SwiftUI

struct BrandMarkView: View {
    let size: CGFloat

    init(size: CGFloat = 72) {
        self.size = size
    }

    var body: some View {
        Image("SomtoMark")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityLabel("Somto")
    }
}
