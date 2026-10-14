/**
 * The pew2 mark: the Scarlet orca above the wordmark, the same orca that sits
 * on the empty chat screen, so the brand is one image rather than a logo seen
 * once and never again.
 *
 * The wordmark is the product name the phone shows, OrcaCoder.
 */
import { StyleSheet, Text, View } from "react-native";
import { OrcaMark } from "./OrcaMark";
import { theme } from "../theme";

interface LogoProps {
  /** Size of the orca. The wordmark scales with it. */
  size?: number;
}

export function Logo({ size = 72 }: LogoProps) {
  return (
    <View
      style={styles.root}
      accessible
      accessibilityRole="image"
      accessibilityLabel="OrcaCoder"
    >
      <OrcaMark size={size} />
      <Text
        style={[
          styles.word,
          {
            fontSize: size * 0.5,
            letterSpacing: size * 0.02,
            // Bitcount's side bearings are asymmetric: the glyph run sits left
            // of its own text box, so centring the box leaves the wordmark
            // visibly off the mark above it. Measured at 4.3pt on a 72pt mark.
            //
            // A margin on a centred child shifts it by half its value, hence
            // double the correction. Expressed as a ratio because bearings
            // scale with font size.
            marginLeft: size * 0.12,
          },
        ]}
        // The mark is already labelled, so the text must not be read twice.
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        OrcaCoder
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: "center", gap: theme.space(2) },
  mark: { marginVertical: -theme.space(4) },
  word: {
    color: theme.color.text,
    // The wordmark is the purest expression of the display face, so it uses the
    // same family as every other title rather than a bespoke treatment.
    fontFamily: theme.display.semibold,
  },
});
