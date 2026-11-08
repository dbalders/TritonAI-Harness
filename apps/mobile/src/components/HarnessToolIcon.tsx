import type { ColorValue } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedSvg = withUniwind(Svg);

export function HarnessToolIcon(props: {
  readonly size: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <ThemedSvg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="currentColor"
      color={props.color}
      colorClassName={props.colorClassName}
      accessible={false}
    >
      <Circle cx={12} cy={3.5} r={2} />
      <Circle cx={5.75} cy={8} r={2} />
      <Circle cx={18.25} cy={8} r={2} />
      <Path d="M11 4h2v18h-2z M5 8h1.5v2.5c0 4 .6 4.8 3.3 5.6 1 .3 1.7 .8 2.2 1.6 .5-.8 1.2-1.3 2.2-1.6 2.7-.8 3.3-1.6 3.3-5.6V8H19v2.5c0 4.4-.8 5.9-4.1 7-1.4.5-1.9 1.8-1.9 4.5h-2c0-2.7-.5-4-1.9-4.5-3.3-1.1-4.1-2.6-4.1-7Z" />
    </ThemedSvg>
  );
}
