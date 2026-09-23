// PinningInitializer.m — wires REAL SSL pinning into the iOS app's network
// stack. Called once from AppDelegate didFinishLaunching, BEFORE React loads.
//
// What it does:
//  1. Registers PinningURLProtocol system-wide (URLProtocol.registerClass) so
//     any default-configuration URLSession created after launch consults it.
//  2. Installs a custom NSURLSessionConfiguration provider through RN's
//     official hook (RCTSetCustomNSURLSessionConfigurationProvider — defined in
//     Libraries/Network/RCTHTTPRequestHandler.mm, which is compiled into the
//     React pod; the symbol is available at link time WITHOUT importing its
//     header, which is why this file is Objective-C rather than Swift).
//     The provider clones the default configuration and prepends
//     PinningURLProtocol to protocolClasses so RN's production HTTP client
//     (globalThis.fetch on iOS) validates pins for pinned HTTPS origins.
//
// Fail-safe design:
//  - MEDA_SPKI_PINS absent/empty (development builds) -> both steps are no-ops
//    and the provider passes the configuration through UNCHANGED. Dev is never
//    pinned to production certificates.
//  - Pins are public-key (SPKI) SHA-256 hashes only — no private material.
//  - System trust evaluation always runs first inside PinningURLProtocol;
//    pinning only RESTRICTS which keys a trusted chain may carry.

#import <Foundation/Foundation.h>

#if __has_include(<React/RCTHTTPRequestHandler.h>)
#import <React/RCTHTTPRequestHandler.h>
#endif

// Defined in React's RCTHTTPRequestHandler.mm (compiled into the React pod).
// Declared here directly because no public umbrella header exposes it.
extern void RCTSetCustomNSURLSessionConfigurationProvider(
    NSURLSessionConfiguration * (^provider)(void));

#import "PinningInitializer.h"

@implementation PinningInitializer

+ (NSString *)pinsKey { return @"MEDA_SPKI_PINS"; }

+ (BOOL)pinsConfigured {
    NSArray *pins = [[NSBundle mainBundle] objectForInfoDictionaryKey:[self pinsKey]];
    return [pins isKindOfClass:[NSArray class]] && pins.count > 0;
}

+ (void)install {
    if (![self pinsConfigured]) {
        // Development/unconfigured build: pinning stays completely inert.
        return;
    }

    // 1. System-wide registration (covers non-RN default sessions too).
    [NSURLProtocol registerClass:NSClassFromString(@"PinningURLProtocol")];

    // 2. Inject into the configuration RN's RCTHTTPRequestHandler will use for
    //    ALL fetch() traffic. Clone the default config and prepend our protocol.
    RCTSetCustomNSURLSessionConfigurationProvider(^NSURLSessionConfiguration *(void) {
        NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
        configuration.HTTPShouldSetCookies = YES;
        configuration.HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicyAlways;
        configuration.HTTPCookieStorage = [NSHTTPCookieStorage sharedHTTPCookieStorage];
        NSMutableArray *protocols = [NSMutableArray arrayWithArray:(configuration.protocolClasses ?: @[])];
        Class pinningClass = NSClassFromString(@"PinningURLProtocol");
        if (pinningClass && ![protocols containsObject:pinningClass]) {
            [protocols insertObject:pinningClass atIndex:0];
        }
        configuration.protocolClasses = protocols;
        return configuration;
    });
}

@end
