import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { tokens } from "@/theme/tokens";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PressableScaleProps extends Omit<PressableProps, "style"> {
  /**
   * Static styles only — press feedback is the scale/dim animation, so the
   * function-style `({pressed}) => …` channel is deliberately closed off.
   */
  style?: StyleProp<ViewStyle>;
  /** Scale target while pressed; defaults to the token (0.97). */
  scaleTo?: number;
}

/**
 * The app-wide touchable: 120ms scale-down + slight dim on press-in, 200ms
 * ease back on release. Replaces bare Pressables so every tap in the app
 * acknowledges the finger the same way. Respects the OS reduce-motion setting.
 */
export function PressableScale({
  style,
  scaleTo = tokens.press.scale,
  onPressIn,
  onPressOut,
  ...rest
}: PressableScaleProps) {
  const pressed = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * (1 - scaleTo) }],
    opacity: 1 - pressed.value * 0.08,
  }));
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(event) => {
        pressed.value = withTiming(1, {
          duration: tokens.motion.fast,
          reduceMotion: ReduceMotion.System,
        });
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        pressed.value = withTiming(0, {
          duration: tokens.motion.base,
          reduceMotion: ReduceMotion.System,
        });
        onPressOut?.(event);
      }}
      style={[style, animatedStyle]}
    />
  );
}
