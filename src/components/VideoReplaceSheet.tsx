/**
 * VideoReplaceSheet.tsx
 *
 * Bottom-sheet presented when the doctor taps "Replace" on an already-linked video.
 *
 * Two branches:
 *   A) Upload New Video      — triggers a new file-picker upload
 *   B) Choose From Library   — opens VideoLibraryPicker
 *
 * After a library pick, shows the replace scope question:
 *   "Replace only this lesson" vs "Replace every lesson using this video"
 */
import { useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, Text, useColorScheme, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Film, Library, RefreshCw, Upload, X } from 'lucide-react-native';
import { neuColors, neuFlatStyle, neuPressedStyle } from '@/lib/neu';
import { VideoLibraryPicker } from '@/components/VideoLibraryPicker';
import {
  attachAssetToLesson, replaceAssetEverywhere,
  type VideoAsset,
} from '@/lib/videoLibraryApi';
import { useToast } from '@/components/Toast';
import { friendlyError } from '@/lib/validation';

interface Props {
  visible: boolean;
  lessonId: string;
  /** Provider video ID currently on this lesson — used to find other lessons using it */
  currentAssetId: string | null;
  /** Count of lessons that share the current video (0 or 1 = no multi-lesson replace needed) */
  sharedLessonCount: number;
  onClose: () => void;
  /** Called when the doctor wants to upload a brand-new file */
  onUploadNew: () => void;
  /** Called after a library video was successfully attached */
  onAssetAttached: () => void;
}

type Step = 'choose_source' | 'choose_scope' | 'applying';

// VideoReplaceSheet uses presentationStyle="formSheet" on iOS (detent sheet).
// On Android that prop is ignored — the modal is full-screen, so we must apply
// a paddingTop matching the status-bar inset ourselves.
export function VideoReplaceSheet({
  visible, lessonId, currentAssetId, sharedLessonCount,
  onClose, onUploadNew, onAssetAttached,
}: Props) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const { showToast } = useToast();

  const [step, setStep] = useState<Step>('choose_source');
  const [showLibraryPicker, setShowLibraryPicker] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<VideoAsset | null>(null);
  const [applying, setApplying] = useState(false);

  const reset = () => {
    setStep('choose_source');
    setSelectedAsset(null);
    setApplying(false);
    setShowLibraryPicker(false);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleLibraryPick = (asset: VideoAsset) => {
    setSelectedAsset(asset);
    setShowLibraryPicker(false);
    // If the current video is used in more than 1 lesson, ask about scope
    if (currentAssetId && sharedLessonCount > 1) {
      setStep('choose_scope');
    } else {
      applyReplace(asset, 'this_lesson');
    }
  };

  const applyReplace = async (asset: VideoAsset, scope: 'this_lesson' | 'all_lessons') => {
    setApplying(true);
    setStep('applying');
    try {
      if (scope === 'all_lessons' && currentAssetId) {
        const count = await replaceAssetEverywhere(currentAssetId, asset);
        showToast({ type: 'success', message: `Video replaced in ${count} lesson${count === 1 ? '' : 's'}.` });
      } else {
        await attachAssetToLesson(lessonId, asset);
        showToast({ type: 'success', message: 'Video replaced in this lesson.' });
      }
      reset();
      onAssetAttached();
    } catch (e) {
      showToast({ type: 'error', message: friendlyError(e, 'Replace failed.') });
      setStep('choose_source');
    }
    setApplying(false);
  };

  const isIOS = process.env.EXPO_OS === 'ios';
  const insets = useSafeAreaInsets();

  return (
    <>
      <Modal
        visible={visible && !showLibraryPicker}
        animationType="slide"
        // presentationStyle="formSheet" gives the native detent sheet on iOS.
        // On Android this prop is silently ignored and the modal is full-screen,
        // so we compensate by adding a paddingTop equal to the status-bar inset.
        presentationStyle="formSheet"
        statusBarTranslucent
        onRequestClose={handleClose}>
        <View style={{ flex: 1, backgroundColor: c.base }}>

          {/* ── Header ──
              iOS formSheet: system renders the drag handle above the content so
              paddingTop only needs a small gap (12 dp). Dynamic Island / notch
              insets are NOT applied inside a formSheet — the OS manages them.
              Android full-screen: no automatic offset, must add insets.top. */}
          <View style={{
            paddingTop: isIOS ? 12 : Math.max(insets.top, 16),
            paddingHorizontal: 20,
            paddingBottom: 16,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontWeight: '800', color: c.text }}>Replace Video</Text>
              <Text style={{ fontSize: 12, color: c.text, opacity: 0.45, marginTop: 2 }}>
                Choose how to replace the current video
              </Text>
            </View>
            <Pressable
              onPress={handleClose}
              style={[neuFlatStyle(isDark), { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }]}>
              <X size={18} color={c.text} opacity={0.5} />
            </Pressable>
          </View>

          <View style={{ flex: 1, padding: 20, gap: 14 }}>

            {/* ── Step: choose_source ── */}
            {step === 'choose_source' && (
              <>
                {/* Upload new */}
                <Pressable
                  onPress={() => { reset(); onUploadNew(); }}
                  style={[neuFlatStyle(isDark), { borderRadius: 18, padding: 20, flexDirection: 'row', alignItems: 'center', gap: 16 }]}>
                  <View style={{ width: 52, height: 52, borderRadius: 14, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                    <Upload size={24} color={c.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>Upload New Video</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 3, lineHeight: 17 }}>
                      Pick a file from your device and upload it as a new asset.
                    </Text>
                  </View>
                </Pressable>

                {/* Choose from library */}
                <Pressable
                  onPress={() => setShowLibraryPicker(true)}
                  style={[neuFlatStyle(isDark), { borderRadius: 18, padding: 20, flexDirection: 'row', alignItems: 'center', gap: 16 }]}>
                  <View style={{ width: 52, height: 52, borderRadius: 14, backgroundColor: `${c.accent}18`, alignItems: 'center', justifyContent: 'center' }}>
                    <Library size={24} color={c.accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '800', color: c.text }}>Choose From My Library</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 3, lineHeight: 17 }}>
                      Reuse an existing upload — no duplicate storage used.
                    </Text>
                  </View>
                </Pressable>
              </>
            )}

            {/* ── Step: choose_scope ── */}
            {step === 'choose_scope' && selectedAsset && (
              <>
                <View style={[neuPressedStyle(isDark), { borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 }]}>
                  <Film size={18} color={c.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: c.text }}>{selectedAsset.title || 'Selected video'}</Text>
                    <Text style={{ fontSize: 11, color: c.text, opacity: 0.4 }}>
                      {selectedAsset.provider_video_id}
                    </Text>
                  </View>
                </View>

                <Text style={{ fontSize: 13, color: c.text, opacity: 0.6, lineHeight: 19 }}>
                  The current video is used in {sharedLessonCount} lessons.{'\n'}Which lessons should be updated?
                </Text>

                {/* This lesson only */}
                <Pressable
                  onPress={() => applyReplace(selectedAsset, 'this_lesson')}
                  style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 14 }]}>
                  <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: `${c.primary}18`, alignItems: 'center', justifyContent: 'center' }}>
                    <Film size={20} color={c.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>Replace only this lesson</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>
                      Other lessons keep using the old video.
                    </Text>
                  </View>
                </Pressable>

                {/* All lessons */}
                <Pressable
                  onPress={() => applyReplace(selectedAsset, 'all_lessons')}
                  style={[neuFlatStyle(isDark), { borderRadius: 16, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 14 }]}>
                  <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: '#D9770618', alignItems: 'center', justifyContent: 'center' }}>
                    <RefreshCw size={20} color="#D97706" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: c.text }}>Replace every lesson using this video</Text>
                    <Text style={{ fontSize: 12, color: c.text, opacity: 0.5, marginTop: 2 }}>
                      All {sharedLessonCount} lessons will be updated.
                    </Text>
                  </View>
                </Pressable>

                <Pressable
                  onPress={() => setStep('choose_source')}
                  style={{ padding: 12, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: c.text, opacity: 0.45 }}>← Back</Text>
                </Pressable>
              </>
            )}

            {/* ── Step: applying ── */}
            {step === 'applying' && (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }}>
                <ActivityIndicator color={c.primary} size="large" />
                <Text style={{ fontSize: 14, color: c.text, opacity: 0.55 }}>Applying replacement…</Text>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* Library picker — shown as a separate modal on top */}
      <VideoLibraryPicker
        visible={showLibraryPicker}
        onClose={() => setShowLibraryPicker(false)}
        onSelect={handleLibraryPick}
      />
    </>
  );
}
