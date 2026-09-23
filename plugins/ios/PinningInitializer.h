// PinningInitializer.h — Swift-visible interface for the pinning bootstrap.
//
// The implementation lives in PinningInitializer.m (it must be Objective-C to
// link RCTSetCustomNSURLSessionConfigurationProvider without importing private
// React headers). AppDelegate.swift calls PinningInitializer.install() from
// didFinishLaunching, so this header is imported by the app target's bridging
// header (see withSecurityModule.js → withIOSSwiftSources).
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface PinningInitializer : NSObject
/// Registers PinningURLProtocol system-wide and installs RN's custom
/// NSURLSessionConfiguration provider so fetch() traffic validates SPKI pins
/// for pinned HTTPS origins. Inert when no MEDA_SPKI_PINS are configured
/// (development builds).
+ (void)install;
@end

NS_ASSUME_NONNULL_END
