import { ChartSvg, type IconProps } from '../utils';

const XS = [4, 10, 17, 24, 29];
const YS1 = [22, 20, 22, 18, 20];
const YS1_OFFSETS = [8, 10, 6, 12, 8];
const YS2 = YS1.map((y, i) => y - YS1_OFFSETS[i]);

export function AreaStackedIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const bottom = 28;

  const pts1Line = XS.map((x, i) => `${x},${YS1[i]}`).join(' ');
  const pts1Area = `${XS[0]},${bottom} ${pts1Line} ${XS[XS.length - 1]},${bottom}`;
  const pts2Line = XS.map((x, i) => `${x},${YS2[i]}`).join(' ');
  const pts2Area = `${XS[0]},${YS1[0]} ${pts2Line} ${XS[XS.length - 1]},${YS1[XS.length - 1]} ${XS.slice()
    .reverse()
    .map((x, i) => `${x},${YS1[XS.length - 1 - i]}`)
    .join(' ')}`;

  return (
    <ChartSvg size={size}>
      <polygon points={pts1Area} fill={c1} opacity={0.35} />
      <polyline
        points={pts1Line}
        stroke={c1}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
      <polygon points={pts2Area} fill={c2} opacity={0.35} />
      <polyline
        points={pts2Line}
        stroke={c2}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
        opacity={0.7}
      />
    </ChartSvg>
  );
}
