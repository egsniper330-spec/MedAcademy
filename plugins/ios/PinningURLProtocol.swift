// Rewrites plugins/ios/PinningURLProtocol.swift as a real URLProtocol subclass.
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
import CryptoKit

// ObjC name is pinned so PinningInitializer.m can locate the class at runtime
// via NSClassFromString("PinningURLProtocol") (a Swift class's default ObjC
// name is mangled; @objc(...) keeps it stable).
@objc(PinningURLProtocol)
final class PinningURLProtocol: URLProtocol, URLSessionDataDelegate {

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

    // URLProtocol overrides its canInit/canonicalRequest class methods (ObjC
    // class methods — dynamically dispatched, hence the `override class func`).
    override class func canInit(with request: URLRequest) -> Bool {
        guard !pins.isEmpty else { return false }               // dev/unpinned build: inert
        guard request.url?.scheme?.lowercased() == "https" else { return false }
        guard let host = request.url?.host?.lowercased() else { return false }
        return pinnedHosts.contains(host)
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let innerConfig = URLSessionConfiguration.ephemeral
        // Guard against re-entrancy: the inner session must NOT consult us again.
        innerConfig.protocolClasses = (innerConfig.protocolClasses ?? [])
            .filter { ($0 as? PinningURLProtocol.Type) == nil }
        innerConfig.httpShouldSetCookies = false
        let inner = URLSession(configuration: innerConfig, delegate: self, delegateQueue: nil)
        innerSession = inner
        inner.dataTask(with: request).resume()
    }

    override func stopLoading() {
        innerSession?.invalidateAndCancel()
        innerSession = nil
    }

    // MARK: - SPKI pin extraction
    //
    // FIX (2026-10-09). The previous implementation hashed
    // `SecKeyCopyExternalRepresentation(key)` — the platform's RAW key encoding
    // (PKCS#1 for RSA, `0x04||X||Y` for EC). Certificate pins are SHA-256 of the
    // DER **SubjectPublicKeyInfo** (SPKI), so that value could never equal a
    // configured pin. With `MEDA_PINNED_HOSTS` non-empty (as it is in this
    // build) `canInit` intercepted every API request and `validatePins` returned
    // false unconditionally — a guaranteed fail-closed that would have made the
    // API unreachable on iOS the moment pinning shipped.
    //
    // The SubjectPublicKeyInfo TLV is now read straight out of the certificate
    // DER, which is byte-for-byte what `openssl x509 -pubkey` emits — i.e.
    // exactly what the configured pin values were computed from. This is
    // format-agnostic: no per-key-type prefix tables, valid for RSA and any EC
    // curve, and independent of SecKeyCopyExternalRepresentation semantics.

    /// One parsed DER TLV. `start` is the header byte (tag) offset, so
    /// `data[start..<end]` is the complete TLV including its header.
    private struct DERNode {
        let tag: UInt8
        let start: Int
        let valueStart: Int
        let end: Int
    }

    /// Read a single DER TLV at `offset` (advances `offset` past it).
    /// Bounded: rejects truncated headers, indefinite lengths and >4-byte
    /// length fields, and never reads beyond `data`. Returns nil on anything
    /// malformed so the caller fails closed.
    private static func readDER(_ data: Data, _ offset: inout Int) -> DERNode? {
        guard offset < data.count else { return nil }
        let start = offset
        let tag = data[offset]
        offset += 1
        guard offset < data.count else { return nil }
        var length = Int(data[offset])
        offset += 1
        if length & 0x80 != 0 {
            let lengthBytes = length & 0x7F
            guard lengthBytes > 0, lengthBytes <= 4, offset + lengthBytes <= data.count else { return nil }
            length = 0
            for _ in 0..<lengthBytes {
                length = (length << 8) | Int(data[offset])
                offset += 1
            }
        }
        guard offset + length <= data.count else { return nil }
        let valueStart = offset
        let end = offset + length
        offset = end
        return DERNode(tag: tag, start: start, valueStart: valueStart, end: end)
    }

    /// `Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }`
    /// `TBSCertificate ::= SEQUENCE { [0] version, serialNumber, signature, issuer,
    ///                                validity, subject, subjectPublicKeyInfo, ... }`
    ///
    /// So the SPKI is the field after subject — the 7th when the optional
    /// `[0] EXPLICIT version` is present, the 6th when it is absent (v1).
    /// Returns the complete SPKI TLV (`start..<end`).
    private static func subjectPublicKeyInfo(from certDER: Data) -> Data? {
        var offset = 0
        guard let cert = readDER(certDER, &offset), cert.tag == 0x30 else { return nil }
        var cursor = cert.valueStart
        guard let tbs = readDER(certDER, &cursor), tbs.tag == 0x30 else { return nil }

        var field = tbs.valueStart
        if readDER(certDER, &field)?.tag != 0xA0 {
            field = tbs.valueStart // no [0] version — rewind to serialNumber
        }
        // serialNumber, signature, issuer, validity, subject → then SPKI
        for _ in 0..<5 {
            guard readDER(certDER, &field) != nil else { return nil }
        }
        guard let spki = readDER(certDER, &field), spki.tag == 0x30 else { return nil }
        return certDER.subdata(in: spki.start..<spki.end)
    }

    /// base64(SHA-256(SPKI DER)) for a certificate, or nil if unparseable.
    private static func spkiDigest(of certificate: SecCertificate) -> String? {
        let certDER = SecCertificateCopyData(certificate) as Data
        guard let spki = subjectPublicKeyInfo(from: certDER) else { return nil }
        return Data(SHA256.hash(data: spki)).base64EncodedString()
    }

    // MARK: - Inner-session challenge handling (the actual pin enforcement)

    /// System trust FIRST (never weaken TLS), then pin restriction: the trusted
    /// chain must carry at least one certificate whose SPKI public key is pinned.
    private func validatePins(trust: SecTrust) -> Bool {
        var error: CFError?
        guard SecTrustEvaluateWithError(trust, &error) else { return false }
        if Self.pins.isEmpty { return true }
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] else { return false }
        for certificate in chain {
            if let digest = Self.spkiDigest(of: certificate), Self.pins.contains(digest) {
                return true
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

    // NOTE: no upload-progress forwarding — URLProtocolClient has no member for
    // it, and the hosting session (RN's) already reports didSendBodyData for
    // tasks served through this protocol.
}
