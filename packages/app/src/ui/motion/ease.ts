/**
 * The app's ease-out as a Reanimated easing, for timed layout animations
 * (entering, layout) that replaced bouncy springs. Same curve as EASE.out.
 */
import { Easing } from "react-native-reanimated";
import { EASE } from "../../motion";

export const EASE_OUT = Easing.bezier(...EASE.out);
