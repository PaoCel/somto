import Foundation
import Testing
@testable import Somto

struct TitleUpdateSupportTests {
    @Test func localizedTextUsesAppLanguageThenFallbacks() {
        let values: [String: Any] = ["it-IT": "Trailer italiano", "en-US": "English trailer"]
        #expect(TitleUpdateSupport.localizedText(values, preferredLocalization: "en") == "English trailer")
        #expect(TitleUpdateSupport.localizedText(["it-IT": "Solo italiano"], preferredLocalization: "en") == "Solo italiano")
    }

    @Test func sourceURLRequiresHTTPSAndAllowedHost() {
        #expect(TitleUpdateSupport.safeSourceURL("https://www.youtube.com/watch?v=abc") != nil)
        #expect(TitleUpdateSupport.safeSourceURL("http://youtube.com/watch?v=abc") == nil)
        #expect(TitleUpdateSupport.safeSourceURL("https://evil.example/watch?v=abc") == nil)
    }

    @Test func titleUpdateDeepLinkPreservesExactEvent() {
        #expect(TitleUpdateSupport.deepLinkFocus(focus: "updates", eventID: "tmdb_video_tv_1_abc") == "updates|tmdb_video_tv_1_abc")
        #expect(TitleUpdateSupport.deepLinkFocus(focus: nil, eventID: nil) == nil)
    }
}
