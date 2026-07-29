/**
 * VideoThumbnailCard.tsx
 * Displays a video thumbnail with overlay controls:
 *   Keep / Replace Thumbnail / Upload Custom Thumbnail / Restore Auto
 * Used in lesson editor after video upload completes.
 */

import { useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, Text, useColorScheme, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Camera, RefreshCw, Upload, Check, X } from 'lucide-react-native';
import { NeuCard } from '@/components/NeuCard';
import { neuColors, neuFlatStyle, neuPressedStyle } from '@/lib/neu';
import { supabase } from '@/client/supabase';
import { updateUploadRecord, updateLessonVideoStatus, insertAuditLog } from '@/lib/videoUploadEngine';
import { usePermission } from '@/hooks/usePermission';
import { PermissionRationaleModal } from '@/components/PermissionRationaleModal';

interface Props {
  thumbnailUrl: string | null;
  autoThumbnailUrl: string | null;   // original AI-generated thumb
  uploadId: string;
  lessonId: string;
  courseId: string;
  onThumbnailChange?: (url: string) => void;
}

const BUCKET = 'course-images'; // custom thumbnails: public bucket (not the private PDF bucket)

export function VideoThumbnailCard({
  thumbnailUrl, autoThumbnailUrl, uploadId, lessonId, courseId, onThumbnailChange,
}: Props) {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? neuColors.dark : neuColors.light;
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState(thumbnailUrl);
  const [showActions, setShowActions] = useState(false);
  const {
    ensurePermission: ensureThumbnailPermission,
    showRationale: showThumbnailRationale,
    setShowRationale: setShowThumbnailRationale,
    isBlocked: thumbnailBlocked,
    confirmRequest: confirmThumbnailRequest,
  } = usePermission('mediaLibrary');

  const updateThumb = async (url: string, storagePath?: string) => {
    setCurrent(url);
    onThumbnailChange?.(url);
    await updateUploadRecord(uploadId, {
      thumbnail_url: url,
      ...(storagePath ? { thumbnail_storage_path: storagePath } : {}),
    });
    await supabase.from('lessons').update({ video_thumbnail_url: url }).eq('id', lessonId);
    await insertAuditLog(uploadId, 'thumbnail_replaced');
    setShowActions(false);
  };

  const handlePickCustom = async () => {
    const granted = await ensureThumbnailPermission();
    if (!granted) return; // rationale modal will appear
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.85,
      allowsEditing: true,
      aspect: [16, 9],
    });
    if (result.canceled || !result.assets?.[0]) return;
    setLoading(true);
    try {
      const { fetch: expoFetch } = await import('expo/fetch');
      const resp = await expoFetch(result.assets[0].uri);
      const blob = await resp.blob();
      const storagePath = `thumbnails/${courseId}/${lessonId}/${uploadId}_custom.jpg`;
      const { error } = await supabase.storage.from(BUCKET).upload(storagePath, blob as any, {
        contentType: 'image/jpeg', upsert: true,
      });
      if (!error) {
        const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
        await updateThumb(data.publicUrl, storagePath);
      }
    } catch (_) {}
    setLoading(false);
  };

  const handleRestoreAuto = async () => {
    if (!autoThumbnailUrl) return;
    await updateThumb(autoThumbnailUrl);
  };

  if (!current) return null;

  return (
    <View style={{ gap: 8 }}>
      <PermissionRationaleModal
        type="mediaLibrary"
        visible={showThumbnailRationale}
        isBlocked={thumbnailBlocked}
        onConfirm={confirmThumbnailRequest}
        onDismiss={() => setShowThumbnailRationale(false)}
      />
      <Text style={{ fontSize: 12, fontWeight: '700', color: c.text, opacity: 0.55 }}>VIDEO THUMBNAIL</Text>
      <NeuCard style={[neuFlatStyle(isDark), { borderRadius: 14, overflow: 'hidden' }]}>
        {/* Thumbnail preview */}
        <View style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: `${c.text}08` }}>
          {loading ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={c.primary} />
            </View>
          ) : (
            <Image
              source={{ uri: current }}
              style={{ width: '100%', height: '100%' }}
              resizeMode="cover"
            />
          )}
          {/* Overlay button */}
          <Pressable
            onPress={() => setShowActions((v) => !v)}
            style={{ position: 'absolute', top: 8, right: 8, backgroundColor: 'rgba(0,0,0,0.55)',
              borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Camera size={13} color="#fff" />
            <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>Change</Text>
          </Pressable>
        </View>

        {/* Action row (expanded) */}
        {showActions && (
          <View style={{ padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: `${c.text}08` }}>
            <Pressable onPress={() => setShowActions(false)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10,
                backgroundColor: '#16A34A12' }}>
              <Check size={14} color="#16A34A" />
              <Text style={{ fontSize: 13, fontWeight: '600', color: '#16A34A' }}>Keep This Thumbnail</Text>
            </Pressable>
            <Pressable onPress={handlePickCustom}
              style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10 }]}>
              <Upload size={14} color={c.primary} />
              <Text style={{ fontSize: 13, fontWeight: '600', color: c.primary }}>Upload Custom Thumbnail</Text>
            </Pressable>
            {autoThumbnailUrl && autoThumbnailUrl !== current && (
              <Pressable onPress={handleRestoreAuto}
                style={[neuFlatStyle(isDark), { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10 }]}>
                <RefreshCw size={14} color="#7C3AED" />
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#7C3AED' }}>Restore Auto Thumbnail</Text>
              </Pressable>
            )}
            <Pressable onPress={() => setShowActions(false)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10 }}>
              <X size={14} color={`${c.text}50`} />
              <Text style={{ fontSize: 13, color: c.text, opacity: 0.5 }}>Cancel</Text>
            </Pressable>
          </View>
        )}
      </NeuCard>
    </View>
  );
}
