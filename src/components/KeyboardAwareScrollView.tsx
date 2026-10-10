/**
 * KeyboardAwareScrollView — THE shared keyboard-avoidance primitive.
 *
 * ─── The defect this replaces ────────────────────────────────────────────────
 *
 * Keyboard handling was applied per screen, in three inconsistent ways:
 *
 *   1. ~38 screens with text inputs had NO keyboard handling at all (a bare
 *      ScrollView). On iOS the software keyboard then covers the lower fields
 *      and the Save button — the reported "keyboard overlaps content while
 *      editing Support contact settings" bug, and its twins across the app.
 *   2. 15 screens wrapped the content in
 *        <KeyboardAvoidingView behavior="padding"> + <ScrollView
 *          contentInsetAdjustmentBehavior="automatic">
 *      On iOS that is a DOUBLE INSET: iOS already adjusts the scroll view's
 *      content insets for the keyboard, and `padding` pushes the whole subtree
 *      up as well. The result is the layout jump / clipped controls class of
 *      bug.
 *   3. Android is configured `adjustResize` (app.json
 *      softwareKeyboardLayoutMode: "resize" + AndroidManifest
 *      android:windowSoftInputMode="adjustResize"), so the OS already resizes
 *      the window. A `KeyboardAvoidingView behavior="height"` on top of that
 *      shrinks the container a SECOND time — more double insets and jumps.
 *
 * ─── The one correct mechanism per platform ─────────────────────────────────
 *
 *   iOS      → ScrollView `automaticallyAdjustKeyboardInsets`. Native, exactly
 *              once, no layout jump, and it keeps the FOCUSED input visible
 *              automatically. No KeyboardAvoidingView — the OS inset is the
 *              single source of truth.
 *   Android  → nothing to add: `adjustResize` already shrinks the window and
 *              the focused input scrolls into view. Adding avoidance here is
 *              what creates double insets.
 *
 * So this component is intentionally NOT a KeyboardAvoidingView: it is a
 * ScrollView configured so that each platform's NATIVE mechanism applies once.
 * That is what makes it safe to use everywhere — including nested inside an
 * existing wrapper — without stacking insets.
 *
 * `keyboardShouldPersistTaps="handled"` keeps a single-tap Save working while
 * the keyboard is open (the second classic form complaint), and the iOS
 * `keyboardDismissMode="interactive"` lets the user swipe the keyboard away.
 *
 * Optional `bottomClearance` adds trailing space so the LAST control is
 * reachable above the keyboard / bottom tab bar.
 */
import React from 'react';
import { Keyboard, Platform, ScrollView, type ScrollViewProps } from 'react-native';

export interface KeyboardAwareScrollViewProps extends ScrollViewProps {
  /**
   * Extra trailing space (dp) appended to the content container, so the last
   * field / Save button can always be scrolled clear of the keyboard and the
   * bottom tab bar. Not a keyboard inset — purely trailing breathing room.
   */
  bottomClearance?: number;
  children?: React.ReactNode;
}

export function KeyboardAwareScrollView({
  bottomClearance = 0,
  contentContainerStyle,
  keyboardShouldPersistTaps = 'handled',
  keyboardDismissMode,
  automaticallyAdjustKeyboardInsets,
  children,
  ...rest
}: KeyboardAwareScrollViewProps) {
  const isIOS = Platform.OS === 'ios';

  return (
    <ScrollView
      //  iOS: the native, once-only keyboard inset. Callers may opt out
      //  explicitly (e.g. a screen already inside a platform scroll host).
      automaticallyAdjustKeyboardInsets={automaticallyAdjustKeyboardInsets ?? isIOS}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      keyboardDismissMode={keyboardDismissMode ?? (isIOS ? 'interactive' : 'on-drag')}
      //  Dismiss on drag-out is handled by the platform; nothing else to add on
      //  Android because `adjustResize` already resized the window.
      contentContainerStyle={[
        bottomClearance > 0 ? { paddingBottom: bottomClearance } : null,
        contentContainerStyle,
      ]}
      {...rest}
    >
      {children}
    </ScrollView>
  );
}

/**
 * Imperatively dismiss the keyboard. Shared so screens do not each import
 * `Keyboard` and use inconsistent APIs.
 */
export function dismissKeyboard(): void {
  Keyboard.dismiss();
}

export default KeyboardAwareScrollView;
