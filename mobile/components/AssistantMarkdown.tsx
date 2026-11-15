import { memo, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';

import { parseAssistantMarkdown, type Block, type Cell, type Row } from '../lib/assistantMarkdown';
import { radius, spacing, type } from '../lib/theme';
import type { Palette } from '../lib/theme';
import { useTheme } from '../lib/theme-context';

/**
 * AI-4 — render the assistant's answer as structure instead of markup.
 *
 * The bubble lives inside a React Native `<Text>`, which is not a Markdown
 * renderer, so before this the model's formatting was shown literally: the
 * 2026-10-13 device run put `| Product | SKU | … |` and its `|---|---|` separator
 * on the screen, in every answer that arrived (ISS-25). Stripping the markers was
 * never an option for a table — the pipes carry the row/column relationship — so
 * the fix is to RENDER the structure the model already writes.
 *
 * WHY A WIDE TABLE BECOMES CARDS, NOT A GRID. This is a phone. The observed
 * answers have five and seven columns, and in a ~400 px bubble a seven-column
 * grid leaves each column under 60 px, which is what makes the screenshot
 * unreadable: every cell wraps to one or two characters. At TWO columns a grid
 * is genuinely better (aligned numbers are easy to compare); ABOVE it, one card
 * per row — the row's own name as its title, its remaining columns as
 * label/value lines — keeps every value legible at the cost of height.
 *
 * WHY THE THRESHOLD MOVED FROM 3 TO 2 (2026-10-19, on the phone). AI-4 chose 3
 * without ever seeing a three-column grid on hardware; the first one did: a
 * complete restock answer drew `| Product | Available QTY | Stock status |` in a
 * ~400 px bubble and the header row wrapped MID-WORD ("Availabl / e QTY"), because
 * the 2:1:1 column split leaves each narrow column under 80 px. The values were
 * readable but the labels were not, and the card layout shows those same three
 * fields as three whole lines. The threshold is a single named constant so the
 * call stays visible and reversible.
 *
 * COST. Nothing here touches the network, the prompt or the model: it is pure
 * string work over an answer already in memory, memoised per answer string, so
 * re-rendering the list (every keystroke in the composer re-renders the parent)
 * does not re-parse a single bubble. The server is untouched, so the answer's
 * latency and token cost are unchanged by construction.
 */

/** At or below this many columns a table is rendered as an aligned grid. */
export const TABLE_GRID_MAX_COLUMNS = 2;

/** The whole answer must have at least two columns to be worth a grid. */
function isGrid(headers: number): boolean {
  return headers > 1 && headers <= TABLE_GRID_MAX_COLUMNS;
}

type Styles = ReturnType<typeof createStyles>;

/** A product the server proved this answer names, with its catalogue id. */
export interface ProductLink {
  productId: string;
  name: string;
  sku?: string;
}

const NO_PRODUCT_LINKS: ProductLink[] = [];

/** Inline spans as plain text — used where a cell is a label, not styled copy. */
function plain(spans: Cell): string {
  return spans.map((span) => span.text).join('');
}

/** Split one text run around product names the answer is allowed to open. */
function withProductLinks(
  text: string,
  textStyle: StyleProp<TextStyle>,
  styles: Styles,
  productLinks: ProductLink[],
  onProductPress?: (productId: string) => void,
): ReactNode {
  if (!text || !productLinks.length || !onProductPress) return text;
  const lower = text.toLowerCase();
  const matches: { link: ProductLink; at: number }[] = [];
  for (const link of productLinks) {
    const name = link.name.trim();
    if (!name) continue;
    let at = lower.indexOf(name.toLowerCase());
    while (at >= 0) {
      const before = at > 0 ? text[at - 1] : '';
      const after = text[at + name.length] ?? '';
      if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) {
        matches.push({ link, at });
        break;
      }
      at = lower.indexOf(name.toLowerCase(), at + 1);
    }
  }
  if (!matches.length) return text;
  matches.sort((a, b) => a.at - b.at);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.at < cursor) continue;
    if (match.at > cursor) nodes.push(text.slice(cursor, match.at));
    nodes.push(
      <Text
        key={`${match.link.productId}-${match.at}`}
        testID={`chat-product-link-${match.link.productId}`}
        accessibilityRole="button"
        style={[textStyle, styles.productLink]}
        onPress={() => onProductPress(match.link.productId)}
      >
        {text.slice(match.at, match.at + match.link.name.length)}
      </Text>,
    );
    cursor = match.at + match.link.name.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/** Inline spans, as nested `<Text>` — so bold is bold rather than markered. */
function Spans({
  spans,
  styles,
  productLinks = NO_PRODUCT_LINKS,
  onProductPress,
}: {
  spans: Cell;
  styles: Styles;
  productLinks?: ProductLink[];
  onProductPress?: (productId: string) => void;
}) {
  return (
    <>
      {spans.map((span, index) => {
        const style = [
          span.bold ? styles.strong : null,
          span.italic ? styles.emphasis : null,
          span.code ? styles.inlineCode : null,
          span.href ? styles.link : null,
        ].filter(Boolean);
        // A research answer quotes its sources as links; they open the listing the price came from.
        const href = span.href;
        if (href) {
          return (
            <Text
              key={index}
              style={style.length ? style : undefined}
              accessibilityRole="link"
              onPress={() => {
                // If no app can take the address, the member still gets the address: a silent no-op
                // looks like a dead link in an answer whose whole point is the source.
                void Linking.openURL(href).catch(() => Alert.alert('Could not open this link', href));
              }}
            >
              {span.text}
            </Text>
          );
        }
        const content =
          span.code || span.href
            ? span.text
            : withProductLinks(
                span.text,
                style.length ? (style as StyleProp<TextStyle>) : undefined,
                styles,
                productLinks,
                onProductPress,
              );
        return (
          <Text key={index} style={style.length ? style : undefined}>
            {content}
          </Text>
        );
      })}
    </>
  );
}

/** One table row as a card: the row's own name, then its attributes. */
function RowCard({
  row,
  header,
  styles,
  productLinks,
  onProductPress,
}: {
  row: Row;
  header: Row;
  styles: Styles;
  productLinks: ProductLink[];
  onProductPress?: (productId: string) => void;
}) {
  const [title, ...rest] = row;
  return (
    <View style={styles.card} testID="assistant-md-row-card">
      <Text style={styles.cardTitle}>
        <Spans spans={title ?? []} styles={styles} productLinks={productLinks} onProductPress={onProductPress} />
      </Text>
      {rest.map((cell, index) => (
        <View key={index} style={styles.cardLine}>
          <Text style={styles.cardLabel}>{plain(header[index + 1] ?? [])}</Text>
          <Text style={styles.cardValue}>
            <Spans spans={cell} styles={styles} productLinks={productLinks} onProductPress={onProductPress} />
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A narrow table as a real grid: header row, then aligned body rows. */
function Grid({
  header,
  rows,
  styles,
  productLinks,
  onProductPress,
}: {
  header: Row;
  rows: Row[];
  styles: Styles;
  productLinks: ProductLink[];
  onProductPress?: (productId: string) => void;
}) {
  return (
    <View style={styles.grid} testID="assistant-md-table-grid">
      <View style={[styles.gridRow, styles.gridHeadRow]}>
        {header.map((cell, index) => (
          <Text key={index} style={[styles.gridHeadCell, index === 0 && styles.gridFirstCell]}>
            {plain(cell)}
          </Text>
        ))}
      </View>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.gridRow}>
          {header.map((_cell, cellIndex) => (
            <Text key={cellIndex} style={[styles.gridCell, cellIndex === 0 && styles.gridFirstCell]}>
              <Spans
                spans={row[cellIndex] ?? []}
                styles={styles}
                productLinks={productLinks}
                onProductPress={onProductPress}
              />
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * The assistant's answer, rendered.
 *
 * `content` is the raw stored message, exactly as the server persisted it — no
 * pre-processing on the way in, so history reloads and live replies render
 * identically through this one path.
 */
export default memo(function AssistantMarkdown({
  content,
  productLinks = NO_PRODUCT_LINKS,
  onProductPress,
}: {
  content: string;
  productLinks?: ProductLink[];
  onProductPress?: (productId: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const blocks: Block[] = useMemo(() => parseAssistantMarkdown(content), [content]);

  if (!blocks.length) return null;

  return (
    <View>
      {blocks.map((block, index) => {
        const first = index === 0;
        switch (block.kind) {
          case 'heading':
            return (
              <Text
                key={index}
                style={[block.level <= 2 ? styles.h2 : styles.h3, !first && styles.spaced]}
              >
                <Spans spans={block.spans} styles={styles} productLinks={productLinks} onProductPress={onProductPress} />
              </Text>
            );
          case 'paragraph':
            return (
              <Text key={index} style={[styles.paragraph, !first && styles.spaced]}>
                <Spans spans={block.spans} styles={styles} productLinks={productLinks} onProductPress={onProductPress} />
              </Text>
            );
          case 'list':
            return (
              <View key={index} style={[styles.list, !first && styles.spaced]}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={styles.listItem}>
                    <Text style={styles.listMarker}>{item.marker}</Text>
                    <Text style={styles.listText}>
                      <Spans spans={item.spans} styles={styles} productLinks={productLinks} onProductPress={onProductPress} />
                    </Text>
                  </View>
                ))}
              </View>
            );
          case 'table': {
            // A table with no header cells is not a table; render its rows as
            // cards anyway rather than dropping them on the floor.
            const columns = Math.max(block.header.length, 1);
            return (
              <View key={index} style={!first && styles.spaced}>
                {isGrid(columns) ? (
                  <Grid
                    header={block.header}
                    rows={block.rows}
                    styles={styles}
                    productLinks={productLinks}
                    onProductPress={onProductPress}
                  />
                ) : (
                  <View testID="assistant-md-table-cards">
                    {block.rows.map((row, rowIndex) => (
                      <RowCard
                        key={rowIndex}
                        row={row}
                        header={block.header}
                        styles={styles}
                        productLinks={productLinks}
                        onProductPress={onProductPress}
                      />
                    ))}
                  </View>
                )}
              </View>
            );
          }
          case 'code':
            return (
              <Text key={index} style={[styles.codeBlock, !first && styles.spaced]}>
                {block.text}
              </Text>
            );
          case 'rule':
            return <View key={index} style={[styles.rule, !first && styles.spaced]} />;
          default:
            return null;
        }
      })}
    </View>
  );
});

const createStyles = (colors: Palette) =>
  StyleSheet.create({
    // Vertical rhythm between blocks. Applied to every block but the first, so a
    // short answer does not start with a gap and a long one reads in sections.
    spaced: { marginTop: spacing.md },

    h2: { ...type.h3, color: colors.text },
    h3: { ...type.label, color: colors.textSecondary, textTransform: 'none' },
    paragraph: { ...type.body, color: colors.text },

    strong: { fontWeight: '700' },
    emphasis: { fontStyle: 'italic' },
    inlineCode: {
      ...type.bodySmall,
      color: colors.text,
      backgroundColor: colors.surfaceMuted,
    },
    link: { color: colors.link, textDecorationLine: 'underline' },
    productLink: { color: colors.primary, fontWeight: '700', textDecorationLine: 'underline' },

    list: { gap: spacing.xs },
    listItem: { flexDirection: 'row', gap: spacing.sm },
    listMarker: { ...type.body, color: colors.primary, fontWeight: '700', minWidth: 16 },
    listText: { ...type.body, color: colors.text, flex: 1 },

    grid: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      overflow: 'hidden',
    },
    gridRow: {
      flexDirection: 'row',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.divider,
    },
    gridHeadRow: { borderTopWidth: 0, backgroundColor: colors.surfaceMuted },
    gridHeadCell: { ...type.caption, color: colors.textSecondary, fontWeight: '700', flex: 1, padding: spacing.sm },
    gridCell: { ...type.bodySmall, color: colors.text, flex: 1, padding: spacing.sm },
    // The first column carries the row's identity (a product, a timestamp), so it
    // gets the extra width a grid's label column always wants.
    gridFirstCell: { flex: 2 },

    card: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surfaceMuted,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      marginBottom: spacing.sm,
    },
    cardTitle: { ...type.listTitle, color: colors.text },
    cardLine: { flexDirection: 'row', marginTop: 3 },
    cardLabel: { ...type.caption, color: colors.textMuted, width: 96 },
    cardValue: { ...type.bodySmall, color: colors.text, flex: 1 },

    codeBlock: {
      ...type.bodySmall,
      color: colors.text,
      backgroundColor: colors.surfaceMuted,
      borderRadius: radius.sm,
      padding: spacing.sm,
    },
    rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.divider },
  });
