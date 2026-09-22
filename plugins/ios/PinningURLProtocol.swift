// Rewrites plugins/ios/PinningURLProtocol.swift as a real NSURLProtocol subclass.
//
// WHY NSURLProtocol (not an auth-challenge delegate): RN's production iOS
// network handler (Libraries/Network/RCTHTTPRequestHandler.mm) creates its
// NSURLSession with `delegate:self` and implements NO auth-challenge method,
// so any challenge uses NSURLSession's default handling — there is no app-level
// hook to intercept. But NSURLProtocol sub-classes registered on a
// configuration's protocolClasses ARE consulted for every request before DNS:
// we can peek at the destination host and only proxy pinned HTTPS origins into
// an inner pinned URLSession that we own (with a challenge delegate); all other
// traffic passes through untouched (zero false-positive surface).
import Foundation

final class PinningURLProtocol: NSURLProtocol, URLSessionDataDelegate {

    private static let pinsKey = "MEDA_SPKI_PINS"

    /// Parsed once per process. Pins are base64 SHA-256 hashes of the server
    /// certificate PUBLIC KEYS (SPKI). No private material is ever embedded.
    private static let pins: Set<String> = {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: pinsKey) as? [String] else {
            return []
        }
        return Set(raw.compactMap { $0.isEmpty ? nil : $0 })
    }()

    /// Hosts whose HTTPS connections must be pinned (case-insensitive).
    /// Empty/nil -> no host is proxied; the protocol is inert.
    private static let pinnedHosts: Set<String> = {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "MEDA_PINNED_HOSTS") as? [String] else {
            return []
        }
        return Set(raw.map { $0.lowercased() }.filter { !$0.isEmpty })
    }()

    /// True when this build actively pins (production builds with pins set).
    static var pinningActive: Bool { !pins.isEmpty }

    private var innerSession: URLSession?
    private var innerData = Data()
    private var responseReceived = false

    // MARK: - Registration (called from AppDelegate didFinishLaunching)

    static func install() {
        // System-wide registration covers default-configuration sessions created
        // after this call (RN's RCTHTTPRequestHandler uses defaultSessionConfiguration
        // unless a custom provider is set). Session-specific protocolClasses are
        // injected in AppDelegate via the RN configuration provider hook.
        URLProtocol.registerClass(PinningURLProtocol.self)
    }

    // MARK: - NSURLProtocol plumbing

    static func canInit(with request: URLRequest) -> Bool {
        guard !pins.isEmpty else { return false }               // dev/unpinned build: inert
        guard request.url?.scheme?.lowercased() == "https" else { return false }
        guard let host = request.url?.host?.lowercased() else { return false }
        return pinnedHosts.contains(host)
    }

    static func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let innerConfig = URLSessionConfiguration.ephemeral
        // Guard against re-entrancy: the inner session must NOT consult us again.
        innerConfig.protocolClasses = (innerConfig.protocolClasses ?? []).filter { $0 != type(of: self) }
        innerConfig.httpShouldSetCookies = false
        let inner = URLSession(configuration: innerConfig, delegate: self, delegateQueue: nil)
        innerSession = inner
        inner.dataTask(with: request).resume()
    }

    override func stopLoading() {
        innerSession?.invalidateAndCancel()
        innerSession = nil
    }

    // MARK: - Inner-session challenge handling (the actual pin enforcement)

    /// System trust FIRST (never weaken TLS), then pin restriction: the trusted
    /// chain must carry at least one pinned SPKI public key.
    private func validatePins(trust: SecTrust) -> Bool {
        var error: CFError?
        guard SecTrustEvaluateWithError(trust, &error) else { return false }
        if Self.pins.isEmpty { return true }
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] else { return false }
        for cert in chain {
            if let key = SecCertificateCopyKey(cert),
               let keyData = SecKeyCopyExternalRepresentation(key, nil) as Data? {
                let digest = Data(SHA256.hash(data: keyData)).base64EncodedString()
                if Self.pins.contains(digest) { return true }
            }
        }
        return false
    }

    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        if validatePins(trust: trust) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil) // fail closed while pinned
        }
    }

    // MARK: - Inner-session data/event pump -> client

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        innerData.append(data)
        client?.urlProtocol(self, didLoad: data)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard !responseReceived else { completionHandler(.allow); return }
        responseReceived = true
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            // Distinguish user-cancel (stopLoading) from real failures.
            if (error as NSError).code != NSURLErrorCancelled {
                client?.urlProtocol(self, didFailWithError: error)
            }
        } else {
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Redirects must re-enter OUR pipeline so the new origin is re-validated.
        if let scheme = request.url?.scheme?.lowercased(), scheme == "https",
           let host = request.url?.host?.lowercased(), Self.pinnedHosts.contains(host) {
            innerSession?.dataTask(with: request).resume()
            completionHandler(nil)
        } else {
            completionHandler(request) // hand back to system (leaves pinned origin)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didSendBodyData bytesSent: Int64, totalBytesSent: Int64,
                    totalBytesExpectedToSend: Int64) {
        client?.urlProtocol(self, didSendBodyData: totalBytesSent,
                            totalBytesExpectedToSend: totalBytesExpectedToSend)
    }
}
