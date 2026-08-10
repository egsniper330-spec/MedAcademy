/**
 * ResponsiveGrid — adaptive column grid built entirely with Flexbox.
 *
 * Columns auto-adapt:
 *   phone portrait  → 2 columns
 *   landscape/phablet → 3 columns
 *   tablet (≥768dp) → 4 columns
 *
 * Children receive an exact `itemWidth` so they can size themselves
 * (e.g. images, cards with aspectRatio). No FlatList — use inside ScrollView.
 *
 * Usage:
 *   <ScrollView>
 *     <ResponsiveGrid gap={12}>
 *       {courses.map(c => <CourseCard key={c.id} width={...} />)}
 *     </ResponsiveGrid>
 *   </ScrollView>
 *
 *   // Or with renderItem for type-safe children:
 *   <ResponsiveGrid data={courses} renderItem={({ item, itemWidth }) =>
 *     <CourseCard course={item} style={{ width: itemWidth }} />
 *   } />
 */
import React from 'react';
import { View, useWindowDimensions, type ViewStyle } from 'react-native';
import { useDS } from '@/lib/ds';

// ─── Generic render-prop variant ──────────────────────────────────────────────
interface ResponsiveGridDataProps<T> {
  data: T[];
  renderItem: (info: { item: T; index: number; itemWidth: number }) => React.ReactNode;
  children?: never;
  cols?: number;
  gap?: number;
  style?: ViewStyle;
  containerPx?: number;
}

// ─── Children variant ─────────────────────────────────────────────────────────
interface ResponsiveGridChildrenProps {
  data?: never;
  renderItem?: never;
  children: React.ReactNode;
  cols?: number;
  gap?: number;
  style?: ViewStyle;
  containerPx?: number;
}

type ResponsiveGridProps<T> = ResponsiveGridDataProps<T> | ResponsiveGridChildrenProps;

export function ResponsiveGrid<T = unknown>({
  data,
  renderItem,
  children,
  cols,
  gap,
  style,
  containerPx,
}: ResponsiveGridProps<T>) {
  const { width } = useWindowDimensions();
  const ds = useDS();

  const numCols = cols ?? ds.gridCols;
  const gapSize = gap ?? ds.spacing.md;
  const hPad    = containerPx ?? ds.screenPx;

  // Item width: fill available width evenly accounting for gaps.
  // totalGap = (numCols - 1) * gapSize (gaps are between items, not outer)
  const availableWidth = width - hPad * 2;
  const itemWidth = Math.floor((availableWidth - gapSize * (numCols - 1)) / numCols);

  // ── Data + renderItem variant ──────────────────────────────────────────────
  if (data && renderItem) {
    // Group items into rows of numCols
    const rows: T[][] = [];
    for (let i = 0; i < data.length; i += numCols) {
      rows.push(data.slice(i, i + numCols));
    }

    return (
      <View style={[{ gap: gapSize }, style]}>
        {rows.map((row, rowIdx) => (
          <View
            key={rowIdx}
            style={{ flexDirection: 'row', gap: gapSize }}
          >
            {row.map((item, colIdx) =>
              renderItem({ item, index: rowIdx * numCols + colIdx, itemWidth }),
            )}
            {/* Pad last row so items don't stretch */}
            {row.length < numCols &&
              Array.from({ length: numCols - row.length }).map((_, i) => (
                <View key={`pad-${i}`} style={{ width: itemWidth }} />
              ))}
          </View>
        ))}
      </View>
    );
  }

  // ── Children variant — wrap in flex rows ───────────────────────────────────
  const childArray = React.Children.toArray(children);
  const rows: React.ReactNode[][] = [];
  for (let i = 0; i < childArray.length; i += numCols) {
    rows.push(childArray.slice(i, i + numCols));
  }

  return (
    <View style={[{ gap: gapSize }, style]}>
      {rows.map((row, rowIdx) => (
        <View key={rowIdx} style={{ flexDirection: 'row', gap: gapSize }}>
          {row}
          {row.length < numCols &&
            Array.from({ length: numCols - row.length }).map((_, i) => (
              <View key={`pad-${i}`} style={{ flex: 1 }} />
            ))}
        </View>
      ))}
    </View>
  );
}
